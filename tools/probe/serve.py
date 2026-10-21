"""Serve a directory over loopback and append POST /log bodies to a file (for testing the page in Safari)."""
import http.server
import sys
import time

root, port, logfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
t0 = time.monotonic()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=root, **kw)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode('utf-8', 'replace')
        with open(logfile, 'a') as f:
            f.write(f'{time.monotonic() - t0:9.3f} {body}\n')
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
