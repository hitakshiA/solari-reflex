#!/usr/bin/env python3
"""reflexd: observe and act on a Linux desktop through its accessibility tree.

Runs inside a Solari desktop, as the desktop user, and serves a tiny JSON-over-HTTP API:

    GET  /health                      -> {"ok": true, "version": N}
    POST /observe {max_elements, max_text_chars}  -> Observation (same shape as the browser observer)
    POST /act     {action, guard}     -> {"navigated": false} or {"error": "stale" | ...}
    POST /screenshot {quality}        -> {"jpeg": base64}

One process holds the AT-SPI connection and a node registry, so every call is a single
request with no interpreter start-up and no tree re-discovery. Requests are served one at a
time: AT-SPI is not thread-safe, and an agent issues one step at a time anyway.

Observation rules, adapted from the browser observer and Cua's cua-driver (MIT):
  - only the active window and any open menus or popups are read;
  - a node is offered when it is showing, enabled, has an action or is editable, and has a
    name (an unnamed list or table row borrows its own text, capped);
  - tables that claim huge child counts (LibreOffice Calc reports 2^31 cells) are never
    enumerated; the focused cell and its neighbours are read instead;
  - every node gets a stable integer id for this process and a guard (role, name, value,
    state) that act() re-checks before any input is sent.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi  # noqa: E402

VERSION = 2
TOKEN = os.environ.get("REFLEXD_TOKEN", "")
S = Atspi.StateType

ROLES = {
    "push button": "button", "toggle button": "button", "button": "button",
    "link": "link", "check box": "checkbox", "check menu item": "menuitem",
    "radio button": "radio", "radio menu item": "menuitem", "menu item": "menuitem",
    "menu": "menuitem", "page tab": "tab", "list item": "option", "table cell": "gridcell",
    "tree item": "row", "table row": "row", "combo box": "combobox", "entry": "textbox",
    "text": "textbox", "password text": None, "spin button": "spinbutton",
    "toggle": "switch", "icon": "button",
}
CONTAINERS = {"filler", "panel", "scroll pane", "viewport", "split pane", "layered pane",
              "root pane", "tool bar", "status bar", "separator", "section", "form"}
HUGE_TABLE = 1000


class Registry:
    """Stable integer ids for accessible nodes, for the life of this process."""

    def __init__(self):
        self.ids = {}
        self.nodes = {}
        self.next = 1

    def key(self, node):
        # Accessible objects are proxies; identity is (bus name, object path).
        try:
            return f"{node.get_bus_name()}{node.get_path()}"
        except Exception:
            return str(id(node))

    def id_of(self, node):
        k = self.key(node)
        if k not in self.ids:
            self.ids[k] = self.next
            self.next += 1
        i = self.ids[k]
        self.nodes[i] = node
        return i

    def get(self, i):
        return self.nodes.get(i)


REG = Registry()


def states_of(node):
    try:
        return node.get_state_set()
    except Exception:
        return None


def name_of(node):
    try:
        return (node.get_name() or "").strip()
    except Exception:
        return ""


def role_of(node):
    try:
        return node.get_role_name()
    except Exception:
        return ""


def text_of(node, limit=200):
    try:
        t = node.get_text_iface()
        if t:
            n = t.get_character_count()
            return (t.get_text(0, min(n, limit)) or "").strip()
    except Exception:
        pass
    return ""


def value_of(node, role):
    if role in ("entry", "text", "spin button", "combo box", "table cell"):
        v = text_of(node)
        if v:
            return v
    try:
        val = node.get_value_iface()
        if val:
            return str(val.get_current_value())
    except Exception:
        pass
    return None


def actions_of(node):
    try:
        a = node.get_action_iface()
        if a:
            return [a.get_action_name(i) for i in range(a.get_n_actions())]
    except Exception:
        pass
    return []


def extents(node):
    try:
        c = node.get_component_iface()
        if c:
            r = c.get_extents(Atspi.CoordType.SCREEN)
            return {"x": r.x, "y": r.y, "w": r.width, "h": r.height}
    except Exception:
        pass
    return None


def guard(node):
    st = states_of(node)
    flags = []
    if st:
        for s in (S.CHECKED, S.SELECTED, S.EXPANDED, S.FOCUSED, S.ENABLED, S.SHOWING, S.SENSITIVE):
            flags.append("1" if st.contains(s) else "0")
    role = role_of(node)
    return json.dumps([role, name_of(node), value_of(node, role), "".join(flags)])


def active_windows():
    """The active top-level window, plus any showing menus, popups and dialogs."""
    desk = Atspi.get_desktop(0)
    active, popups = None, []
    for i in range(desk.get_child_count()):
        app = desk.get_child_at_index(i)
        if app is None:
            continue
        for j in range(app.get_child_count()):
            w = app.get_child_at_index(j)
            if w is None:
                continue
            st = states_of(w)
            if not st or not st.contains(S.SHOWING):
                continue
            role = role_of(w)
            if st.contains(S.ACTIVE) and role in ("frame", "dialog", "window", "alert", "file chooser"):
                active = (app, w)
            elif role in ("menu", "popup menu", "window", "tool tip") and st.contains(S.VISIBLE):
                popups.append((app, w))
    return active, popups


def walk(root, out, text, limits, depth=0):
    if len(out) >= limits["nodes"]:
        return
    try:
        n = root.get_child_count()
    except Exception:
        return
    role = role_of(root)
    if role in ("table", "tree table") and n > HUGE_TABLE:
        cell_neighbourhood(root, out, text, limits)
        return
    for i in range(min(n, 400)):
        child = root.get_child_at_index(i)
        if child is None:
            continue
        st = states_of(child)
        if not st or not st.contains(S.SHOWING):
            continue
        consider(child, st, out, text, limits)
        walk(child, out, text, limits, depth + 1)


def consider(node, st, out, text, limits):
    role = role_of(node)
    name = name_of(node)
    mapped = ROLES.get(role)
    if role in ("label", "static", "heading", "paragraph") and name:
        if limits["text"] > 0:
            text.append(name[:160])
            limits["text"] -= len(name) + 1
        return
    if mapped is None or role in CONTAINERS:
        return
    if not (st.contains(S.ENABLED) or st.contains(S.SENSITIVE)):
        return
    editable = st.contains(S.EDITABLE) and mapped in ("textbox", "combobox", "spinbutton", "gridcell")
    acts = actions_of(node)
    if not acts and not editable:
        return
    if not name and mapped in ("row", "option", "gridcell"):
        name = text_of(node, 80)
    if not name and editable:
        # LibreOffice's Name Box is an unnamed entry inside a combo box called "Name Box".
        try:
            name = name_of(node.get_parent())
        except Exception:
            name = ""
    if not name and not editable:
        return
    el = {"node": REG.id_of(node), "role": mapped, "name": name or mapped, "editable": bool(editable)}
    box = extents(node)
    if box and box["w"] > 0:
        el["rect"] = box
    v = value_of(node, role)
    if v:
        el["value"] = v[:200]
    if role in ("check box", "toggle button", "radio button", "check menu item", "radio menu item"):
        el["checked"] = "true" if st.contains(S.CHECKED) else "false"
    if st.contains(S.EXPANDABLE):
        el["expanded"] = "true" if st.contains(S.EXPANDED) else "false"
    if st.contains(S.SELECTABLE):
        el["selected"] = "true" if st.contains(S.SELECTED) else "false"
    out.append(el)


def col_name(c):
    s = ""
    c += 1
    while c:
        c, r = divmod(c - 1, 26)
        s = chr(65 + r) + s
    return s


def cell_neighbourhood(table, out, text, limits):
    """Spreadsheet-sized tables (Calc reports 2^31 cells): read the used, visible area as text
    rows, and offer the active cell as an editable control named by its address ("E2")."""
    try:
        t = table.get_table_iface()
        ext = extents(table)
        if not t or not ext:
            return
        # Width of the used area: header row until two empty cells in a row.
        ncols, empty = 0, 0
        for c in range(26):
            if text_of(t.get_accessible_at(0, c), 80):
                ncols, empty = c + 1, 0
            else:
                empty += 1
                if empty >= 2:
                    break
        ncols = max(ncols, 1)
        blank_rows = 0
        fillable = 0
        for r in range(0, 500):
            first = t.get_accessible_at(r, 0)
            box = extents(first) if first else None
            if not box or box["y"] > ext["y"] + ext["h"]:
                break
            if box["y"] + box["h"] < ext["y"]:
                continue
            values = []
            for c in range(ncols + 1):
                cell = t.get_accessible_at(r, c)
                if cell is None:
                    continue
                v = text_of(cell, 80)
                values.append(v)
                st = states_of(cell)
                # An empty cell under a header is a place data goes: offer it by its address.
                if not v and r > 0 and c < ncols and fillable < 60 and text_of(t.get_accessible_at(0, c), 80):
                    fillable += 1
                    el = {"node": REG.id_of(cell), "role": "gridcell", "name": f"{col_name(c)}{r + 1}", "editable": True}
                    cb = extents(cell)
                    if cb:
                        el["rect"] = cb
                    out.append(el)
                    continue
                if st and st.contains(S.FOCUSED):
                    el = {"node": REG.id_of(cell), "role": "gridcell", "name": f"{col_name(c)}{r + 1}", "editable": True}
                    if v:
                        el["value"] = v
                    cb = extents(cell)
                    if cb:
                        el["rect"] = cb
                    out.append(el)
            if any(values):
                blank_rows = 0
                row = " | ".join(f"{col_name(c)}={v}" for c, v in enumerate(values) if v)
                if limits["text"] > 0:
                    text.append(f"Row {r + 1}: {row}")
                    limits["text"] -= len(row) + 10
            else:
                blank_rows += 1
                if blank_rows >= 3:
                    break
    except Exception:
        pass


def observe(max_elements=120, max_text_chars=3000):
    active, popups = active_windows()
    if active is None and not popups:
        return None
    out, text = [], []
    limits = {"nodes": max_elements * 4, "text": max_text_chars}
    roots = [w for _, w in popups] + ([active[1]] if active else [])
    for w in roots:
        walk(w, out, text, limits)
    seen, elements = set(), []
    for el in out:
        if el["node"] in seen:
            continue
        seen.add(el["node"])
        elements.append(el)
    omitted = max(0, len(elements) - max_elements)
    elements = elements[:max_elements]
    for i, el in enumerate(elements):
        el["id"] = f"e{i + 1}"
    counts = {}
    for el in elements:
        counts[el["name"]] = counts.get(el["name"], 0) + 1
    focused = None
    guards = {}
    for el in elements:
        node = REG.get(el["node"])
        guards[str(el["node"])] = guard(node) if node else ""
        st = states_of(node) if node else None
        if st and st.contains(S.FOCUSED):
            focused = el["id"]
    app_name = name_of(active[0]) if active else name_of(popups[0][0])
    title = name_of(active[1]) if active else ""
    key_src = json.dumps([title, [(e["node"], e.get("value"), e.get("checked"), e.get("selected")) for e in elements]])
    screen = screen_size()
    obs = {
        "url": f"app://{app_name}/{title}",
        "title": title,
        "viewport": {"width": screen[0], "height": screen[1]},
        "scroll": {"y": 0, "height": screen[1]},
        "text": "\n".join(text)[:max_text_chars],
        "elements": elements,
        "omitted": omitted,
        "pageKey": hashlib.sha1(key_src.encode()).hexdigest(),
        "guards": guards,
    }
    if focused:
        obs["focused"] = focused
    return obs


_SCREEN = None


def screen_size():
    global _SCREEN
    if _SCREEN is None:
        try:
            out = subprocess.run(["xdotool", "getdisplaygeometry"], capture_output=True, text=True, timeout=2).stdout.split()
            _SCREEN = (int(out[0]), int(out[1]))
        except Exception:
            _SCREEN = (1280, 800)
    return _SCREEN


def xdo(*args):
    subprocess.run(["xdotool", *args], capture_output=True, timeout=5)


KEYS = {"Enter": "Return", "Escape": "Escape", "Tab": "Tab"}


def act(action, expected_guard):
    kind = action.get("kind")
    node = None
    if "node" in action:
        node = REG.get(int(action["node"]))
        if node is None:
            return {"error": "gone"}
        # No guard means the caller has nothing to check against: refuse rather than act blind.
        if expected_guard is None or guard(node) != expected_guard:
            return {"error": "stale"}
    before = window_signature()
    if kind == "click":
        if not do_action(node, ("click", "press", "activate", "jump", "toggle")):
            box = extents(node)
            if not box or box["w"] <= 0:
                return {"error": "covered"}
            xdo("mousemove", str(box["x"] + box["w"] // 2), str(box["y"] + box["h"] // 2), "click", "1")
    elif kind == "type":
        text = action.get("text", "")
        if role_of(node) == "table cell":
            # Select-all would select the whole sheet: move the cursor to the cell, type, commit
            # with Enter. Focus through the accessibility API, not a click: Calc reports cell
            # extents offset from where the grid is drawn.
            focus(node)
            time.sleep(0.05)
            xdo("type", "--delay", "4", "--", text)
            xdo("key", "--clearmodifiers", "Return")
        elif action.get("submit"):
            # Submitting needs keyboard focus in the field (a Name Box jump, a search box), so
            # use real key input rather than setting the text through the accessibility API.
            focus(node)
            xdo("key", "--clearmodifiers", "ctrl+a")
            xdo("type", "--delay", "4", "--", text)
            xdo("key", "--clearmodifiers", "Return")
        elif not set_text(node, text):
            focus(node)
            xdo("key", "--clearmodifiers", "ctrl+a")
            xdo("type", "--delay", "4", "--", text)
    elif kind == "select":
        focus(node)
        if not select_value(node, action.get("value", "")):
            return {"error": "option"}
    elif kind == "press":
        key = KEYS.get(action.get("key"))
        if key is None:
            return {"error": "key"}
        xdo("key", "--clearmodifiers", key)
    elif kind == "scroll":
        w, h = screen_size()
        xdo("mousemove", str(w // 2), str(h // 2), "click", "--repeat", "5", "5" if action.get("direction") == "down" else "4")
    elif kind == "wait":
        time.sleep(0.1)
    settle(before)
    return {"navigated": window_signature() != before}


def do_action(node, preferred):
    try:
        a = node.get_action_iface()
        if not a:
            return False
        names = [a.get_action_name(i) for i in range(a.get_n_actions())]
        for want in preferred:
            if want in names:
                return a.do_action(names.index(want))
        return a.do_action(0) if names else False
    except Exception:
        return False


def focus(node):
    try:
        c = node.get_component_iface()
        if c and c.grab_focus():
            return True
    except Exception:
        pass
    box = extents(node)
    if box:
        xdo("mousemove", str(box["x"] + box["w"] // 2), str(box["y"] + box["h"] // 2), "click", "1")
    return False


def set_text(node, text):
    try:
        e = node.get_editable_text_iface()
        if e and e.set_text_contents(text):
            return True
    except Exception:
        pass
    return False


def select_value(node, value):
    try:
        sel = node.get_selection_iface()
        if sel:
            for i in range(node.get_child_count()):
                ch = node.get_child_at_index(i)
                if name_of(ch) == value:
                    return sel.select_child(i)
    except Exception:
        pass
    return set_text(node, value)


def window_signature():
    active, popups = active_windows()
    parts = []
    if active:
        parts.append(f"{name_of(active[0])}/{name_of(active[1])}")
    parts += [f"popup:{name_of(w)}" for _, w in popups]
    return "|".join(parts)


def settle(before, cap=1.5):
    """Wait until the active window and its focus stop changing, capped. Two quiet samples 60 ms apart."""
    deadline = time.time() + cap
    last = None
    quiet = 0
    while time.time() < deadline:
        sig = window_signature() + "#" + focused_signature()
        if sig == last:
            quiet += 1
            if quiet >= 2:
                return
        else:
            quiet = 0
        last = sig
        time.sleep(0.06)


def focused_signature():
    try:
        active, _ = active_windows()
        if not active:
            return ""
        return str(active[1].get_child_count())
    except Exception:
        return ""


def screenshot(quality=70):
    path = "/tmp/reflexd-shot.jpg"
    subprocess.run(["import", "-window", "root", "-quality", str(quality), path], capture_output=True, timeout=10)
    try:
        with open(path, "rb") as f:
            return base64.b64encode(f.read()).decode()
    except OSError:
        return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorised(self):
        return not TOKEN or self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"ok": True, "version": VERSION})
        self.reply(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorised():
            return self.reply(401, {"error": "unauthorised"})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self.reply(400, {"error": "bad json"})
        t0 = time.time()
        try:
            if self.path == "/observe":
                result = observe(body.get("max_elements", 120), body.get("max_text_chars", 3000))
            elif self.path == "/act":
                result = act(body.get("action", {}), body.get("guard"))
            elif self.path == "/screenshot":
                result = {"jpeg": screenshot(body.get("quality", 70))}
            else:
                return self.reply(404, {"error": "not found"})
        except Exception as e:  # never let one bad request kill the daemon
            return self.reply(500, {"error": f"{type(e).__name__}: {e}"})
        self.reply(200, {"result": result, "ms": int((time.time() - t0) * 1000)})


def main():
    port = int(os.environ.get("REFLEXD_PORT", "7788"))
    host = os.environ.get("REFLEXD_HOST", "0.0.0.0")
    server = HTTPServer((host, port), Handler)
    print(f"reflexd {VERSION} on {host}:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
