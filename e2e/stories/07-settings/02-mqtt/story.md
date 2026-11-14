# Send the car's values to an MQTT broker

**Category** Settings
**Persona** Owner with Home Assistant who wants the state of charge on the dashboard and in automations
**Spec** [`mqtt.spec.ts`](mqtt.spec.ts)

## Why it matters

Home automation reads MQTT. With the publisher on, the car's values are on the
broker every 30 seconds without a second logger asking the car, and the badge
says at a glance whether EVBook is actually connected — a wrong address or
password shows up here, not as silence in Home Assistant.

## Preconditions

- MQTT off, nothing stored (the seeded settings).
- The spec starts its own small broker on a free local port; nothing leaves the machine.

## Steps

| # | Step | Expected |
|---|------|----------|
| 1 | Open Settings | The MQTT card, off, asking for a broker first |
| 2 | Enter a broker with the login in the address, leave the field | Refused: the login belongs in its own fields |
| 3 | Enter the broker, user name and password | Each saves as its field is left, no button; the password field says it is stored, never shows it |
| 4 | Turn MQTT on | The badge turns to Connected, and the broker sees `evbook/status` online |
| 5 | Turn it off | The broker sees `evbook/status` offline; the spec then clears the settings for the other stories |
