/* =============================================================
   NeuroReadiness — ESP32 firmware
   Streams MAX30102 (PPG) + MPU6050 (IMU) + CJMCU-6701 GSR over USB
   serial as CSV lines that the browser app's SerialSensor parses directly:

       t_ms,red,ir,ax,ay,az,gsr

   The browser app's live-sensor mode consumes this serial protocol directly.
   The simulated mode emits the same sample shape so both paths use the same
   signal-processing and scoring pipeline.

   ── Wiring (I2C, both sensors share the bus) ──────────────────
     MAX30102   VIN→3V3   GND→GND   SDA→GPIO21   SCL→GPIO22
     MPU6050    VCC→3V3   GND→GND   SDA→GPIO21   SCL→GPIO22
     CJMCU-6701 VCC→3V3   GND→GND   SIG→GPIO34
   (MAX30102 default addr 0x57, MPU6050 0x68 — no conflict.)

   ── Libraries (Arduino Library Manager) ───────────────────────
     • "SparkFun MAX3010x Pulse and Proximity Sensor Library"
     • "Adafruit MPU6050" (pulls in Adafruit Unified Sensor + BusIO)

   ── Serial ────────────────────────────────────────────────────
     115200 baud. Must match NR.config.SERIAL_BAUD in js/util.js.

   Sensor placement and individual hardware can affect signal quality.
   Use the app's fit gate and confidence indicators before each session.
   ============================================================= */

#include <Wire.h>
#include "MAX30105.h"          // SparkFun driver also covers the MAX30102
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>

MAX30105 ppg;
Adafruit_MPU6050 imu;

const uint32_t SAMPLE_HZ = 50;
const uint32_t SAMPLE_INTERVAL_US = 1000000UL / SAMPLE_HZ;
const int GSR_PIN = 34;  // ADC1 input, input-only and safe while Wi-Fi is off

uint32_t startMs = 0;
uint32_t lastSampleUs = 0;
bool imuPresent = false;

void setup() {
  Serial.begin(115200);
  while (!Serial) { delay(10); }

  Wire.begin(21, 22);
  Wire.setClock(400000);  // 400 kHz I2C
  analogReadResolution(12);
  analogSetPinAttenuation(GSR_PIN, ADC_11db); // 0–3.3 V range

  // --- PPG ---
  if (!ppg.begin(Wire, I2C_SPEED_FAST)) {
    Serial.println("# ERROR: MAX30102 not found — check wiring/address");
    while (1) { delay(1000); }
  }
  // ledBrightness, sampleAverage, ledMode(2=red+IR), sampleRate,
  // pulseWidth, adcRange. Tunable per placement (finger vs temple).
  ppg.setup(0x1F, 4, 2, 100, 411, 4096);
  ppg.setPulseAmplitudeRed(0x1F);
  ppg.setPulseAmplitudeIR(0x1F);

  // --- IMU (optional; motion artifact detection degrades gracefully) ---
  if (imu.begin()) {
    imuPresent = true;
    imu.setAccelerometerRange(MPU6050_RANGE_4_G);
    imu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  } else {
    Serial.println("# WARN: MPU6050 not found — streaming PPG only");
  }

  // Protocol banner. SerialSensor ignores any line not starting with a
  // digit, so this is safe to print.
  Serial.println("# NRDY,2");  // NeuroReadiness protocol v2: adds GSR ADC column
  startMs = millis();
  lastSampleUs = micros();
}

void loop() {
  uint32_t nowUs = micros();
  if (nowUs - lastSampleUs < SAMPLE_INTERVAL_US) return;
  lastSampleUs += SAMPLE_INTERVAL_US;

  uint32_t red = ppg.getRed();
  uint32_t ir = ppg.getIR();

  float ax = 0, ay = 0, az = 1;  // default ~1 g rest if no IMU
  if (imuPresent) {
    sensors_event_t a, g, temp;
    imu.getEvent(&a, &g, &temp);
    // Convert m/s^2 → g so it matches the browser's motion thresholds.
    ax = a.acceleration.x / 9.80665f;
    ay = a.acceleration.y / 9.80665f;
    az = a.acceleration.z / 9.80665f;
  }

  uint32_t t = millis() - startMs;
  uint16_t gsr = analogRead(GSR_PIN); // raw CJMCU-6701 analog output, 0–4095

  // t_ms,red,ir,ax,ay,az,gsr
  Serial.print(t);        Serial.print(',');
  Serial.print(red);      Serial.print(',');
  Serial.print(ir);       Serial.print(',');
  Serial.print(ax, 3);    Serial.print(',');
  Serial.print(ay, 3);    Serial.print(',');
  Serial.print(az, 3);    Serial.print(',');
  Serial.println(gsr);
}
