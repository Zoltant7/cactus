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
    ├── vendor/
    │   ├── cactus.js              (you copy these in)
    │   └── cactus.wasm
    └── models/
        └── mirage.cact
        └── config.json  
        
```

## Build & install

1. Add this repo : https://github.com/Zoltant7/cactus
2. In HA, go to **Settings → Apps → top-right menu → **Reload**. The "Cactus Mirage Describe" add-on should appear in the list of local add-ons.
3. Click it, then **Install**. First build pulls a Node.js image (~80 MB) and installs `sharp` — takes 3-5 minutes.
4. **Start** the add-on. Check the **Log** tab — you should see:

   ```
   [cactus] loading engine (first run takes a few seconds)…
   [cactus] engine ready, model: 21600000 bytes
   Cactus describe service → http://0.0.0.0:3002
   ```

5. Test from inside HA (Settings → Add-ons → Terminal & SSH → Open) OPTIONAL:

   ```bash
   curl -X POST -H "content-type: application/octet-stream" \
     --data-binary "@/test.jpg" \
     http://localhost:3002/describe
   ```
6. Add to the configuration.yaml (reboot , or reload , now you'll have the shell action available in the automations )
   ```yaml
   shell_command:
       describe_image: >
         curl -s -X POST
         -H "Content-Type: application/octet-stream"
         --data-binary "@{{ file_path }}"
         http://localhost:3002/describe
   ```
## Using from a HA automation (YAML)

```yaml
automation:
  - alias: cactus
    description: Analyze camera10 snapshots with Cactus Mirage and alert whatever detection
    triggers:
      - trigger: event.received
        target:
          entity_id: event.folder_watcher_share_motioneye_camera10
        options:
          event_type:
            - created
    conditions: []
    actions:
      - action: shell_command.describe_image
        data:
          file_path: '{{ trigger.to_state.attributes.path }}'
        response_variable: cactus_result
      - variables:
          vision: '{{ cactus_result.stdout | from_json }}'
          detected_objects: '{{ vision.objects | map(attribute=''name'') | unique | list }}'
          orkcs: |
            {{ vision.objects
               | selectattr('name', 'equalto', 'convertible car')
               | selectattr('score', '>=', 0.3)
               | list }}
      - condition: template
        value_template: '{{ orkcs | count > 0 }}'
      - action: notify.mobile_app
        data:
          title: Spotted on Camera 10
          message: >
            Scene: {{ vision.scene.setting }} ({{ vision.scene.lighting }}).
            Objects: {{ detected_objects | join(', ') }}.
    mode: queued
    max: 5
```

   
## Using from Node-RED

In your Node-RED `http request` node, point to:

```
http://cactus_mirage:3002/describe
```

(or `http://<HA-IP>:3002/describe` from outside the add-on network — the add-on maps port 3002 to your HA host.)

Import the flow `nodered-cactus-flow.json` and change the URL accordingly.


(Sending a binary body from a HA automation needs a small intermediate step — usually easier to do via Node-RED. Use the Node-RED flow above and trigger it from HA via MQTT or the Node-RED companion integration.)

## Logs & troubleshooting

- Add-on **Log** tab shows engine load + per-request timing
- If startup fails with `Missing file: .../cactus.js`, you forgot to copy the engine files in step 2
- If `sharp` install fails on aarch64, change the Dockerfile `FROM` line to `node:20-bookworm` (slower install, wider arch support)

## Resources

- ~50 MB RAM idle, ~120 MB peak during inference
- ~2-3 seconds first request, 200-1500ms subsequent on amd64, slower on aarch64
- No GPU used — pure WASM
