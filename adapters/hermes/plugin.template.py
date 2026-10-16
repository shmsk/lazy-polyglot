# lazy-polyglot
"""Lazy Polyglot adapter for Hermes Agent.

Installed by `lazy-polyglot install hermes` into $HERMES_HOME/plugins/lazy-polyglot/.
All logic lives in the TypeScript CLI; this file only shells out to it.

- pre_llm_call: Hermes fires it once per user turn, before the tool loop.
  We pipe the turn into `lazy-polyglot hook` and return the <lazy-polyglot> block as
  {"context": ...}, which Hermes appends to the user message. Same contract as
  the Claude Code UserPromptSubmit hook.
- post_llm_call: fires once the turn's final answer is done. We hand the
  answer to `lazy-polyglot hook` as a Stop event, so only the words it really
  used count as shown (weave algorithm 3).
- /lazy-polyglot <args>: routes to the CLI (lang, level, pause, resume, status)
  and returns its output. Works in the CLI and on gateway platforms.

Sacred hook contract (matches src/cli.ts): never break the host session.
Every failure path returns None. Runtime detection prefers bun, then Node:
Node >= 23.6 native, Node 22.6+ and early 23 with --experimental-strip-types.
Standard library only; Python 3.8+.
"""

import json
import os
import re
import shlex
import subprocess

CLI_PATH = "__LAZY_POLYGLOT_CLI_PATH__"  # replaced at install time
TIMEOUT = 5

# Subcommands safe to run from a chat. quiz is interactive and init/install
# touch the host config, so they stay terminal-only.
COMMANDS = ("lang", "level", "mode", "pause", "resume", "status", "validate", "instruction", "export", "import")


def _runtimes():
    yield ["bun", CLI_PATH]
    try:
        v = subprocess.run(["node", "-v"], capture_output=True, text=True, timeout=TIMEOUT).stdout.strip()
    except Exception:
        return
    m = re.match(r"^v(\d+)\.(\d+)", v)
    if not m:
        return
    major, minor = int(m.group(1)), int(m.group(2))
    if major > 23 or (major == 23 and minor >= 6):
        yield ["node", CLI_PATH]
    elif major == 23 or (major == 22 and minor >= 6):
        yield ["node", "--experimental-strip-types", CLI_PATH]


def _run(args, stdin=""):
    """Run the CLI with the first runtime that exists. None if none ran."""
    for base in _runtimes():
        try:
            return subprocess.run(
                base + args,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=TIMEOUT,
            )
        except FileNotFoundError:
            continue  # runtime not installed, try the next one
        except Exception:
            return None
    return None


def _session(session_id):
    """The CLI keeps one served slot per session id and files an empty id under a
    shared "default" slot, so two id-less sessions would settle each other's words.
    Fall back to the process: separate TUI and cron runs stay apart."""
    return session_id or "pid-%d" % os.getpid()


def pre_llm_call(session_id="", user_message="", **kwargs):
    try:
        payload = json.dumps({
            "prompt": user_message or "",
            "session_id": _session(session_id),
            "hook_event_name": "UserPromptSubmit",
        })
        r = _run(["hook"], payload)
        block = r.stdout.strip() if r is not None and r.returncode == 0 else ""
        return {"context": block} if block else None
    except Exception:
        return None


def post_llm_call(session_id="", assistant_response="", **kwargs):
    try:
        if not assistant_response:
            return None
        payload = json.dumps({
            "session_id": _session(session_id),
            "hook_event_name": "Stop",
            "last_assistant_message": assistant_response,
        })
        _run(["hook"], payload)
    except Exception:
        pass
    return None


def lazy_polyglot_command(raw_args=""):
    try:
        args = shlex.split(raw_args or "")
    except ValueError:
        args = (raw_args or "").split()
    if not args or args[0] not in COMMANDS:
        return "Usage: /lazy-polyglot <" + "|".join(COMMANDS) + "> [args]"
    r = _run(args)
    if r is None:
        return "Lazy Polyglot: the CLI did not run. It needs bun or Node.js >= 22.6."
    # errors (bad language code, wrong level) come back on stderr
    return (r.stdout.strip() or r.stderr.strip()) or "ok"


def register(ctx):
    ctx.register_hook("pre_llm_call", pre_llm_call)
    ctx.register_hook("post_llm_call", post_llm_call)
    ctx.register_command(
        "lazy-polyglot",
        handler=lazy_polyglot_command,
        description="Lazy Polyglot: lang, level, pause, resume, status, export, import",
        args_hint="<lang|level|pause|resume|status|export|import> [args]",
    )
