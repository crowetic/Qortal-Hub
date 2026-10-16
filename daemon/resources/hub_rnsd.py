"""Run the upstream rnsd CLI with a parent-lifetime watchdog.

The pipe closes even if Node is killed abruptly. This prevents an orphaned rnsd
from owning the shared port after a service restart. No network protocol lives
in this wrapper.
"""
import os
import runpy
import sys
import threading


def watch_owner():
    try:
        while sys.stdin.buffer.read(1):
            pass
    finally:
        os._exit(0)


threading.Thread(target=watch_owner, daemon=True).start()
runpy.run_module("RNS.Utilities.rnsd", run_name="__main__")
