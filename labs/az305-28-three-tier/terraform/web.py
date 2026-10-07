# web.py: the web tier (ca-web), run as python3 -c by main.tf.
#
# Plain English: answers on port 8080 (the ingress target port). A request
# that does not carry this lab's Front Door profile id in X-Azure-FDID came
# round Front Door, straight to the app's public name, so it is refused with
# 403. Anything else is passed on: the page shows what the app tier
# (http://ca-app, reachable only inside the environment) says. Standard
# library only, so it runs on Microsoft's Azure Linux Python image.
import http.server
import os
import urllib.request

FDID = os.environ["FRONT_DOOR_ID"]
APP = os.environ.get("APP_URL", "http://ca-app")


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, code, text):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        if self.headers.get("X-Azure-FDID", "") != FDID:
            self.reply(403, "403 Forbidden: the web tier answers only through this lab's Front Door.\n")
            return
        try:
            with urllib.request.urlopen(APP, timeout=10) as r:
                app = r.read().decode()
        except Exception as e:
            app = "The app tier did not answer: " + str(e) + "\n"
        self.reply(200, "Web tier (ca-web), reached through Front Door\n\n" + app)

    do_HEAD = do_GET


http.server.ThreadingHTTPServer(("", 8080), Handler).serve_forever()
