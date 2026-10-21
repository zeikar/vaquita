"""Daemon stand-in: every second, release a probe to each page over long-poll (like a WebSocket push),
and log how long the page takes to answer it through xterm (write DA1 -> onData -> POST /ack)."""
import http.server
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

root, port, logfile = sys.argv[1], int(sys.argv[2]), sys.argv[3]
cond = threading.Condition()
seq = 0
released = {}
lock = threading.Lock()


def log(s):
    with lock, open(logfile, 'a') as f:
        f.write(f'{time.time():.3f} {s}\n')


def ticker():
    global seq
    while True:
        time.sleep(1)
        with cond:
            seq += 1
            cond.notify_all()


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=root, **kw)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path != '/next':
            return super().do_GET()
        q = parse_qs(u.query)
        w, after = q['w'][0], int(q['after'][0])
        log(f'NEXT {w} after={after}')
        with cond:
            cond.wait_for(lambda: seq > after, timeout=30)
            s = seq
        released[(w, s)] = time.time()
        body = str(s).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(n).decode('utf-8', 'replace')
        q = parse_qs(u.query)
        if u.path == '/ack':
            w, s = q['w'][0], int(q['s'][0])
            t0 = released.get((w, s))
            log(f'ACK {w} {s} rtt_ms={(time.time() - t0) * 1000 if t0 else -1:.1f}')
        else:
            log(f'LOG {body}')
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass


threading.Thread(target=ticker, daemon=True).start()
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
