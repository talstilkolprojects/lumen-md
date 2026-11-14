// Wait until the Docker servers of docker-compose.yml answer (plan W6.27):
// Nextcloud installs itself on first start, which takes a minute or two.
const checks = [
  ["Nextcloud", "http://127.0.0.1:8080/remote.php/dav/files/lumen/", { Authorization: "Basic " + btoa("lumen:lumen-real-test") }],
  ["Apache mod_dav", "http://127.0.0.1:18086/dav/", { Authorization: "Basic " + btoa("tal:pw") }],
  ["MinIO", "http://127.0.0.1:9000/minio/health/ready", {}],
];
const until = Date.now() + 5 * 60_000;
for (const [name, url, headers] of checks) {
  for (;;) {
    const status = await fetch(url, { method: name === "MinIO" ? "GET" : "PROPFIND", headers: { Depth: "0", ...headers } }).then((r) => r.status, () => 0);
    if (status === 207 || status === 200) break;
    if (Date.now() > until) throw new Error(`${name} did not answer (${status})`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`${name}: ready`);
}
