# NeuroReadiness

NeuroReadiness is a browser-based cognitive performance instrument that combines short cognitive tasks with pulse, motion and electrodermal arousal data. It tracks alertness, cognitive control, working memory, physiological context, and signal confidence against each person's own history.

## Run a Check

Open the hosted product and select one of two paths:

- **Full diagnostic:** connect the ESP32 sensor suite and run the test with live MAX30102, MPU6050 and CJMCU-6701 data.
- **Simulated experience:** explore the full workflow without hardware using a generated pulse, motion and arousal stream.

The hardware guide, wiring table, firmware, and connection steps are included in the product under **Run a test**.

## Hardware

The full diagnostic uses:

- ESP32 development board
- MAX30102 pulse sensor
- MPU6050 motion sensor
- CJMCU-6701 GSR skin-resistance sensor
- Breadboard and jumper wires
- USB data cable

The included firmware streams `t_ms,red,ir,ax,ay,az,gsr` samples over USB serial. Live connection uses the Web Serial API and therefore requires a Chromium-based desktop browser.

## Privacy

Profiles and session summaries are stored locally in the browser with IndexedDB. Sensor data is processed on the device; no account or cloud upload is required.

## Important Notice

NeuroReadiness is a performance and research tool, not a medical device. It does not diagnose, treat, or prevent any condition. Temple PPG measures superficial skin perfusion, not cerebral blood flow. GSR is an electrodermal arousal proxy, not an emotion reader, lie detector, or stress diagnosis.

## License

MIT License. See [LICENSE](LICENSE).
