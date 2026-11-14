// A WebDAV server on golang.org/x/net/webdav, the handler that rclone serve
// webdav, hacdias/webdav and others are built on (plan W6.27).
// Usage: gowebdav <addr> <dir> <user> <password>
package main

import (
	"log"
	"net/http"
	"os"

	"golang.org/x/net/webdav"
)

func main() {
	addr, dir, user, pass := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	h := &webdav.Handler{FileSystem: webdav.Dir(dir), LockSystem: webdav.NewMemLS()}
	log.Fatal(http.ListenAndServe(addr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u, p, ok := r.BasicAuth(); !ok || u != user || p != pass {
			w.Header().Set("WWW-Authenticate", `Basic realm="dav"`)
			http.Error(w, "auth", http.StatusUnauthorized)
			return
		}
		h.ServeHTTP(w, r)
	})))
}
