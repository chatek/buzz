#!/usr/bin/env python3
"""Threaded static file server for the e2e suite.

WHY THIS EXISTS. `python3 -m http.server` uses http.server.HTTPServer, which is
SINGLE-THREADED: it handles one request at a time and every other connection waits.
Measured 2026-10-03 while chasing the config-bridge:250 flake. The failing assertion is
`chat-title` not found within 5s, and the failure snapshot is exactly ViewLoadingFallback
kind="channel" - a lazy route chunk that had not loaded. The chunk is only 2,960 bytes, so
transfer size cannot explain 5s; the request was QUEUED BEHIND another one. Holding a single
request with page.route reproduced the identical DOM and error text, which is what
head-of-line blocking looks like from the test's side.

This is not a widened timeout. It removes a serialization defect in the harness so the tests
measure the app rather than the server's queue.

Usage: python3 static-server.py <port> <directory>
"""
import functools
import http.server
import socketserver
import sys


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: static-server.py <port> <directory>", file=sys.stderr)
        return 2
    port = int(sys.argv[1])
    directory = sys.argv[2]
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"threaded static server on 127.0.0.1:{port} serving {directory}", flush=True)
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
