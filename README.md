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
http://<HA-IP>:3002/describe
```

Import the flow `nodered-cactus-flow.json` and change the URL accordingly.
'''json
[{"id":"watch_tab","type":"tab","label":"Folder → Cactus Describe","disabled":false,"info":"Watches a directory for new image files. When one appears, sends it to the cactus-mirage add-on and saves the JSON result next to the image (with a .json extension)."},{"id":"watch_folder","type":"watch","z":"watch_tab","name":"Watch","files":"/share/motioneye/Camera10/","recursive":true,"x":92,"y":613,"wires":[["filter_images"]]},{"id":"filter_images","type":"switch","z":"watch_tab","name":"Only images","property":"payload","propertyType":"msg","rules":[{"t":"regex","v":"\\.(jpg|jpeg|png|webp|bmp|gif)$","vt":"str","case":false}],"checkall":"true","repair":false,"outputs":1,"x":160,"y":519,"wires":[["wait_for_write"]]},{"id":"wait_for_write","type":"delay","z":"watch_tab","name":"Let file write finish (1s)","pauseType":"delay","timeout":"1","timeoutUnits":"seconds","rate":"1","nbRateUnits":"1","rateUnits":"second","randomFirst":"1","randomLast":"5","randomUnits":"seconds","drop":false,"allowrate":false,"outputs":1,"x":138,"y":416,"wires":[["set_filename"]]},{"id":"set_filename","type":"function","z":"watch_tab","name":"Build paths","func":"// watch node puts the full path in msg.payload.\n// file in node wants msg.filename.\nconst imagePath = msg.payload\nconst jsonPath = imagePath.replace(/\\.[^.]+$/, '') + '.json'\n\nmsg.filename = imagePath\nmsg.imagePath = imagePath\nmsg.jsonPath = jsonPath\n\n// Remember the bare filename for logging.\nmsg.imageName = imagePath.split(/[\\\\/]/).pop()\n\n// Clear msg.payload — we don't want to accidentally stream it to the file in node.\nmsg.payload = null\nreturn msg","outputs":1,"timeout":"","noerr":0,"initialize":"","finalize":"","libs":[],"x":108,"y":78,"wires":[["read_file"]]},{"id":"read_file","type":"file in","z":"watch_tab","name":"Read image bytes","filename":"filename","filenameType":"msg","format":"","chunk":false,"sendError":false,"encoding":"none","allProps":false,"x":183,"y":135,"wires":[["post_to_cactus","22e4c9a8e720d0eb"]]},{"id":"post_to_cactus","type":"http request","z":"watch_tab","name":"POST to cactus-mirage :3002","method":"POST","ret":"obj","paytoqs":"ignore","url":"http://192.168.1.10:3002/describe","tls":"","persist":false,"proxy":"","insecureHTTPParser":false,"authType":"","senderr":false,"headers":[{"keyType":"other","keyValue":"","valueType":"other","valueValue":""},{"keyType":"other","keyValue":"","valueType":"other","valueValue":""}],"x":501,"y":133,"wires":[["on_result","save_json","log_result"]]},{"id":"on_result","type":"function","z":"watch_tab","name":"Tag the result","func":"// Stash the cactus JSON under msg.result and build a small summary for debug.\nconst r = msg.payload || {}\nconst sceneBits = r.scene\n  ? Object.entries(r.scene).map(([k,v]) => `${k.replace(/_/g,' ')}: ${v}`).join(', ')\n  : ''\nconst objList = (r.objects || []).map(o => o.name).join(', ')\n\nmsg.result = r\nmsg.payload = [\n  `📸 ${msg.imageName}`,\n  sceneBits ? `Scene: ${sceneBits}` : null,\n  objList ? `Objects: ${objList}` : 'No objects detected',\n  (r.text && r.text.length) ? `Text: ${r.text.map(t => '\"' + t.string + '\"').join(' ')}` : null,\n  `Inference: ${r._ms || '?'} ms`\n].filter(Boolean).join('\\n')\n\nreturn msg","outputs":1,"x":813,"y":143,"wires":[["debug_summary"]]},{"id":"save_json","type":"function","z":"watch_tab","name":"Prep JSON body","func":"// Pretty-print the JSON for the .json file next to the image.\nmsg.payload = JSON.stringify(msg.payload, null, 2)\nreturn msg","outputs":1,"x":356,"y":245,"wires":[["write_json_file"]]},{"id":"write_json_file","type":"file","z":"watch_tab","name":"Write <image>.json","filename":"{{jsonPath}}","appendNewline":false,"createDir":true,"overwriteFile":"true","encoding":"utf8","x":591,"y":252,"wires":[["debug_saved"]]},{"id":"log_result","type":"debug","z":"watch_tab","name":"Log timing","active":true,"tosidebar":false,"console":true,"tostatus":false,"complete":"\"described \" & imageName & \" in \" & payload._ms & \"ms\"","targetType":"jsonata","statusVal":"","statusType":"auto","x":788,"y":53,"wires":[]},{"id":"debug_summary","type":"debug","z":"watch_tab","name":"Summary","active":true,"tosidebar":true,"console":false,"complete":"payload","targetType":"msg","statusVal":"","statusType":"auto","x":1036,"y":143,"wires":[]},{"id":"debug_saved","type":"debug","z":"watch_tab","name":"Saved JSON path","active":false,"console":false,"complete":"jsonPath","targetType":"msg","x":844,"y":255,"wires":[]},{"id":"setup_note","type":"comment","z":"watch_tab","name":"Setup","info":"1. Edit the watch node's directory to your snapshot folder.\n   Common HA paths: /config/snapshots/  /config/www/captures/  /media/camera/\n   On Windows Node-RED: C:\\\\Users\\\\you\\\\Pictures\\\\snapshots\\\\\n\n2. Make sure the directory exists and Node-RED has write access to it\n   (the .json sidecar files get written there).\n\n3. The watch node watches ALL files in the directory — the filter node\n   immediately drops anything that isn't a recognized image extension.\n\n4. The 1-second delay after the watch fires lets the camera finish writing\n   the file. If you see 'Could not decode image' or partial results, increase\n   to 2 or 3 seconds.\n\n5. Each image triggers ONE describe call. The same file being modified later\n   (e.g. timestamped rewrites) will trigger again — that's usually what you want.","x":357,"y":318,"wires":[]},{"id":"22e4c9a8e720d0eb","type":"debug","z":"watch_tab","name":"all","active":true,"tosidebar":false,"console":true,"tostatus":false,"complete":"true","targetType":"full","statusVal":"","statusType":"auto","x":302,"y":62,"wires":[]}]
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
