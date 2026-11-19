# Cactus Mirage Home Assistant Add-on

Runs the same `cactus.js` + `cactus.wasm` + `mirage.cact` engine as the browser demo, but inside the Home Assistant add-on container. Exposes an HTTP endpoint that Node-RED (or any HA automation) can call to describe images.

## Layout inside the add-on

```
/                  (add-on repo root)
├── config.yaml
├── Dockerfile
├── rootfs/
│   └── etc/
│       └── cont-init.d/
│           └── 00-setup.sh        (creates /data/app folder)
└── app/
    ├── cactus-node.mjs            (the HTTP service)
    ├── package.json
    ├── vendor/
    │   ├── cactus.js              (you copy these in)
    │   └── cactus.wasm
    └── models/
        └── mirage.cact
```

## Build & install

1. Put the add-on files on your HA machine.

   Easiest: if you have the **Samba** or **Samba share** add-on, drop the whole `ha-addon-cactus/` folder into `/addons/` on your HA share. Otherwise use the **File editor** add-on or SSH.

2. Copy your working engine files into the add-on before building:

   ```
   ha-addon-cactus/app/vendor/cactus.js
   ha-addon-cactus/app/vendor/cactus.wasm
   ha-addon-cactus/app/models/mirage.cact
   ```

   (Same files you already downloaded for the browser app. Don't re-download — the truncated-file bug we just fixed lives there too.)

3. In HA, go to **Settings → Add-ons → Add-on Store** → top-right menu → **Reload**. The "Cactus Mirage Describe" add-on should appear in the list of local add-ons.

4. Click it, then **Install**. First build pulls a Node.js image (~80 MB) and installs `sharp` — takes 3-5 minutes.

5. **Start** the add-on. Check the **Log** tab — you should see:

   ```
   [cactus] loading engine (first run takes a few seconds)…
   [cactus] engine ready, model: 21600000 bytes
   Cactus describe service → http://0.0.0.0:3002
   ```

6. Test from inside HA (Settings → Add-ons → Terminal & SSH → Open):

   ```bash
   curl -X POST -H "content-type: application/octet-stream" \
     --data-binary "@/test.jpg" \
     http://cactus_mirage:3002/describe
   ```

   Note the hostname `cactus_mirage` — that's the add-on slug, resolvable inside the HA add-on network.

## Using from Node-RED

In your Node-RED `http request` node, point to:

```
http://cactus_mirage:3002/describe
```

(or `http://<HA-IP>:3002/describe` from outside the add-on network — the add-on maps port 3002 to your HA host.)

Import the flow `nodered-cactus-flow.json` and change the URL accordingly.

## Using from a HA automation (YAML)

```yaml
automation:
  - alias: "Describe new image"
    trigger:
      - platform: folder_watcher
        folder: "/config/images/incoming"
    action:
      - service: rest_command.describe_image
        data:
          file_path: "{{ trigger.event.data.path }}"
```

```yaml
rest_command:
  describe_image:
    url: "http://cactus_mirage:3002/describe"
    method: POST
    content_type: "application/octet-stream"
    # For binary upload, use the file payload approach.
```

(Sending a binary body from a HA automation needs a small intermediate step — usually easier to do via Node-RED. Use the Node-RED flow above and trigger it from HA via MQTT or the Node-RED companion integration.)

## Logs & troubleshooting

- Add-on **Log** tab shows engine load + per-request timing
- If startup fails with `Missing file: .../cactus.js`, you forgot to copy the engine files in step 2
- If `sharp` install fails on aarch64, change the Dockerfile `FROM` line to `node:20-bookworm` (slower install, wider arch support)

## Resources

- ~50 MB RAM idle, ~120 MB peak during inference
- ~2-3 seconds first request, 200-1500ms subsequent on amd64, slower on aarch64
- No GPU used — pure WASM
