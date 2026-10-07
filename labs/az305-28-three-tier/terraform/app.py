# app.py: the app tier's API container (ca-app, "api"), run as python3 -c by main.tf.
#
# Plain English: answers on port 8080 (internal ingress only). Each request
# looks up the SQL server's name (inside the VNet it resolves, through the
# privatelink zone, to the private endpoint's address), tries TCP 1433, and
# shows the last query result the sqltools sidecar wrote to the shared
# EmptyDir volume. Standard library only: Python cannot speak to SQL Server
# without a driver, so the sidecar's sqlcmd does the querying.
import http.server
import os
import socket

SERVER = os.environ["SQL_SERVER"]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            ip = socket.gethostbyname(SERVER)
        except Exception as e:
            ip = "no answer (" + str(e) + ")"
        try:
            socket.create_connection((SERVER, 1433), timeout=5).close()
            tcp = "open"
        except Exception as e:
            tcp = "not reachable (" + str(e) + ")"
        try:
            with open("/shared/db.txt") as f:
                db = f.read().strip()
        except Exception:
            db = "no result yet: the sqltools container queries appdb once a minute"
        text = (
            "App tier (ca-app, internal ingress)\n"
            + "  " + SERVER + " resolves to " + ip + "\n"
            + "  TCP 1433: " + tcp + "\n\n"
            + "Data tier (appdb, the sidecar's last query):\n  " + db + "\n"
        )
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


http.server.ThreadingHTTPServer(("", 8080), Handler).serve_forever()
