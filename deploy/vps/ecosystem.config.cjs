// The demo's PM2 definition. It ships *inside each release* and is started by
// path (`pm2 start /srv/evbook/current/ecosystem.config.cjs`), deliberately not
// merged into any shared ecosystem file — the box may host other apps, so
// EVBook never edits their config and stays addable and removable on its own.
//
// `cwd` is the symlink rather than the resolved release, so a rollback is
// repointing `current` and restarting; PM2 re-reads the path on restart.

module.exports = {
  apps: [
    {
      name: "evbook-demo",
      cwd: "/srv/evbook/current",
      script: "dist/server/main.js",
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,

      // PM2 itself runs as root here (that is how the box is set up); the app
      // must not. Everything it writes lives under /srv/evbook/data, which
      // bootstrap.sh chowns to this user.
      uid: "evbook",
      gid: "evbook",

      env: {
        NODE_ENV: "production",
        DEMO: "true",
        // The fixture world is already geocoded and there is no car to poll, so
        // the minute clock would only make outbound Nominatim/elevation calls
        // on behalf of anonymous visitors. See deploy/vps/README.md.
        DISABLE_CRON: "true",
        // A demo cannot install anything, so an update banner would just be a
        // dead control on someone else's deployment.
        DISABLE_UPDATE_CHECK: "true",
        PORT: "3100",
        // Bind the loopback only. The server defaults to 0.0.0.0 (right for a
        // container, where binding loopback would make it unreachable), but on
        // a public box that publishes the whole demo on
        // http://<ip>:3100 — no TLS, and straight past Caddy and Cloudflare,
        // which makes the origin lock in deploy/cloudflare/ pointless. Caddy
        // reaches it over 127.0.0.1 and is the only thing that should.
        HOST: "127.0.0.1",
        // Outside the release directory: a deploy replaces the code, never the
        // data, and reseed.sh owns this file's lifecycle.
        DATABASE_PATH: "/srv/evbook/data/evbook.sqlite",
        BLOBS_DIR: "/srv/evbook/data/blobs",
        ASSETS_DIR: "/srv/evbook/current/dist/client",
        MIGRATIONS_DIR: "/srv/evbook/current/migrations",
      },

      max_memory_restart: "400M",
      autorestart: true,
      // A boot that fails every time (a bad build, a corrupt database) should
      // stop and stay visible in `pm2 list` rather than spin.
      max_restarts: 10,
      min_uptime: "20s",
      restart_delay: 2000,

      error_file: "/var/log/evbook/demo.error.log",
      out_file: "/var/log/evbook/demo.out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
