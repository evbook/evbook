# MQTT

EVBook can send each car's current values to an MQTT broker, for Home
Assistant, Node-RED or anything else that reads MQTT. Turn it on in
**Settings → MQTT**: the broker's address, a user name and password if it
wants one, and a topic prefix (`evbook` unless you change it).

Only the Node server publishes ([vps.md](./vps.md)): it keeps one connection
open for as long as it runs. On Cloudflare the card is not shown; an open
socket would keep a Durable Object from hibernating
([proposals/home-assistant.md](./proposals/home-assistant.md), "Rejected").

## What is sent, and when

- **Every 30 seconds**, each car's summary, the same values the car's page
  shows. EVBook reads what it already has and asks the car nothing, so
  publishing costs no wake-ups and no provider requests.
- **Only what changed** since the last send. After every (re)connect
  everything is sent once more, in case the broker lost its retained messages.
- **Retained, QoS 1.** A client that subscribes later gets the current values
  at once.
- **Empty means unknown.** A value the car does not report, or no longer
  reports, is an empty payload, never `0` or `false`. Sent retained, an empty
  payload deletes the topic on the broker, so a client that subscribes later
  gets nothing for it rather than a stale value. Booleans are `true` and
  `false`, instants ISO 8601 in UTC.
- **The position is included** (`latitude`, `longitude`, `heading_deg`): anyone
  who may read these topics on your broker sees where the car is.

The connection carries a last will: `<prefix>/status` is `online` while EVBook
is connected and becomes `offline` when it stops or the connection drops.

A topic is not cleared when a car is removed from EVBook or the prefix is
changed; delete the old retained topics on the broker if they bother you
(`mosquitto_pub -r -n -t <topic>`).

## Topics

All below `<prefix>/cars/<id>/`, where `<id>` is the car's number in EVBook
(the one in its page's address, `/cars/1`). Names are the summary's fields in
snake_case, with the unit appended where the name does not carry it.

| Topic | Payload | Meaning |
|---|---|---|
| `display_name` | text | The car's name in EVBook |
| `provider` | `tesla`, `volvo` | Who logs the car |
| `state` | `driving`, `charging`, `updating`, `falling_asleep`, `online`, `asleep`, `offline`, `unknown` | What the logger sees the car doing |
| `since` | ISO 8601 | When that state began |
| `healthy` | `true`, `false` | The last request to the car succeeded |
| `last_error` | text | Why it did not, while it did not |
| `sleep_blocker` | text | Why the car cannot fall asleep right now (Tesla) |
| `data_at` | ISO 8601 | The car's own timestamp for the values below |
| `last_fetch_at` | ISO 8601 | When EVBook last got any answer from the car |
| `geofence` | text | Name of the geofence the car is in; empty in none |
| `battery_level_pct` | % | State of charge |
| `usable_battery_level_pct` | % | State of charge that can be used (Tesla, lower in the cold) |
| `charge_limit_soc_pct` | % | Charge limit |
| `ideal_battery_range_km` | km | Ideal range |
| `rated_battery_range_km` | km | Rated range |
| `est_battery_range_km` | km | Estimated range |
| `odometer_km` | km | Odometer |
| `speed_kmh` | km/h | Speed |
| `power_kw` | kW | Drive power; negative while regenerating |
| `shift_state` | `P`, `R`, `N`, `D` | Gear |
| `latitude` | degrees | Position |
| `longitude` | degrees | Position |
| `heading_deg` | degrees | Heading |
| `inside_temp_c` | °C | Cabin temperature |
| `outside_temp_c` | °C | Outside temperature |
| `driver_temp_setting_c` | °C | Climate setpoint, driver |
| `passenger_temp_setting_c` | °C | Climate setpoint, passenger |
| `is_climate_on` | `true`, `false` | Climate control on |
| `is_preconditioning` | `true`, `false` | Preconditioning |
| `battery_heater` | `true`, `false` | Battery heater on |
| `cabin_overheat_protection` | text | Cabin overheat protection setting |
| `cop_actively_cooling` | `true`, `false` | Cabin overheat protection is cooling |
| `auto_seat_climate_left` | `true`, `false` | Automatic seat climate, left |
| `auto_seat_climate_right` | `true`, `false` | Automatic seat climate, right |
| `auto_steering_wheel_heat` | `true`, `false` | Automatic steering wheel heat |
| `locked` | `true`, `false` | Locked |
| `sentry_mode` | `true`, `false` | Sentry mode on |
| `is_user_present` | `true`, `false` | Someone is in the car |
| `doors_open` | `true`, `false` | Any door open |
| `door_df_open` | `true`, `false` | Driver front door open |
| `door_pf_open` | `true`, `false` | Passenger front door open |
| `door_dr_open` | `true`, `false` | Driver rear door open |
| `door_pr_open` | `true`, `false` | Passenger rear door open |
| `trunk_open` | `true`, `false` | Trunk open |
| `windows_open` | `true`, `false` | Any window open |
| `window_fd_open` | `true`, `false` | Front driver window open |
| `window_fp_open` | `true`, `false` | Front passenger window open |
| `window_rd_open` | `true`, `false` | Rear driver window open |
| `window_rp_open` | `true`, `false` | Rear passenger window open |
| `dashcam_state` | text | Dashcam state |
| `charging_state` | `Disconnected`, `NoPower`, `Starting`, `Charging`, `Stopped`, `Complete` | Charging state |
| `charge_port_door_open` | `true`, `false` | Charge port open |
| `conn_charge_cable` | text | The cable plugged in, e.g. `IEC` |
| `charger_power_kw` | kW | Charging power |
| `charger_voltage_v` | V | Charging voltage |
| `charger_current_a` | A | Charging current |
| `charger_phases` | number | Phases in use |
| `charge_energy_added_kwh` | kWh | Energy added in this session |
| `charge_rate_kmh` | km/h | Range gained per hour of charging |
| `time_to_full_charge_h` | h | Time until the charge limit |
| `scheduled_charging_pending` | `true`, `false` | Waiting for scheduled charging |
| `trip_charging` | `true`, `false` | Charging for a trip |
| `version` | text | Software version |
| `update_available` | `true`, `false` | A software update is available |
| `update_version` | text | Its version |
| `tpms_pressure_fl_bar` | bar | Tyre pressure, front left |
| `tpms_pressure_fr_bar` | bar | Tyre pressure, front right |
| `tpms_pressure_rl_bar` | bar | Tyre pressure, rear left |
| `tpms_pressure_rr_bar` | bar | Tyre pressure, rear right |
| `tpms_soft_warning_fl` | `true`, `false` | Tyre warning, front left |
| `tpms_soft_warning_fr` | `true`, `false` | Tyre warning, front right |
| `tpms_soft_warning_rl` | `true`, `false` | Tyre warning, rear left |
| `tpms_soft_warning_rr` | `true`, `false` | Tyre warning, rear right |

Which of these a car fills depends on the maker: a Volvo reports fewer values
than a Tesla ([volvo.md](./volvo.md)), and the rest stay empty. Units are metric whatever the display units in
Settings are, so a consumer can convert without knowing them.

Not published yet: the tyre list, the Volvo maintenance figures and the active
navigation route, which are nested rather than single values. They follow with
shared entity definitions, from which Home Assistant's MQTT discovery could be
generated too.

## Example

```sh
mosquitto_sub -h 192.168.1.10 -u evbook -P '…' -v -t 'evbook/#'
```

```
evbook/status online
evbook/cars/1/display_name Eve
evbook/cars/1/state charging
evbook/cars/1/battery_level_pct 57
evbook/cars/1/charger_power_kw 11
evbook/cars/1/geofence Home
```

The code: [`src/platform/node/mqtt/`](../src/platform/node/mqtt/) (connection,
publisher, source) and [`src/core/mqtt.ts`](../src/core/mqtt.ts) (topic names and
payloads).
