#!/usr/bin/env python3
"""Tiny static server for the Uplift dashboard with no-cache headers.

python3 -m http.server caches index.html in browsers (conditional revalidate
without ETag => heuristic freshness), which pins stale ?v= stamps and serves
old JS after a deploy. This sends no-store for index.html so a deploy is
immediately visible; assets stay cacheable via their ?v= stamps.

Run: python3 scripts/uplift-server.py [--port 11436] [directory]
"""
import argparse
import functools
import http.server
import socketserver


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path in ('/', '/index.html', '/'):
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, format, *args):  # quieter console
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11436)
    ap.add_argument("directory", nargs="?", default=".")
    args = ap.parse_args()
    handler = functools.partial(Handler, directory=args.directory)
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as srv:
        print(f"uplift static server on http://127.0.0.1:{args.port} ({args.directory})")
        srv.serve_forever()


if __name__ == "__main__":
    main()
