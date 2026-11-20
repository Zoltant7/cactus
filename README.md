# Cactus Mirage Home Assistant App

Runs the same `cactus.js` + `cactus.wasm` + `mirage.cact` engine as the browser demo, but inside the Home Assistant App container. Exposes an HTTP endpoint that Node-RED (or any HA automation) can call to describe images. (https://github.com/cactus-compute/cactus)

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FZoltant7%2Fcactus)

## Install

1.Settings > Apps > Install App > Repositories > Add 
```
https://github.com/Zoltant7/cactus
```
3. Click it, then **Install**. First build pulls a Node.js image (~80 MB) and installs `sharp` — takes 3-5 minutes.
4. **Start** the app.


5. Test from inside HA (Settings → Apps → Terminal & SSH → Open) OPTIONAL:

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
   So when an image is saved, the Folder watcher sends an event , the automation trigger kicks in to send the image to our Cactus endpoint from where we will get back the evaluation !
   In the example we search for a "convertible car"  (because my fancy neighbor was annoying enough to provide the sample ).

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

Import the flow `node_red__flow_cactus.json` from the repo dir and change the URL accordingly.

(Sending a binary body from a HA automation needs a small intermediate step — usually easier to do via Node-RED. Use the Node-RED flow above and trigger it from HA via MQTT or the Node-RED companion integration.)


## Resources

- ~50 MB RAM idle, ~120 MB peak during inference
- ~2-3 seconds first request, 200-1500ms subsequent on amd64, slower on aarch64
- No GPU used — pure WASM
- on my tiny N3160 it takes 22 second to respond
