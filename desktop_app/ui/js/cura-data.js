/**
 * Dobot MOOZ Official Cura Slicing Profiles & Machine Definitions
 * Reverse engineered from MOOZ Studio 2.3.2-beta CuraEngine distribution
 * 100% Offline Data
 */

export const CURA_PROFILES = {
  'mooz-1-2': {
    id: 'mooz-1-2',
    name: 'Dobot MOOZ-1 / MOOZ-2',
    kinematics: 'Cartesian',
    shape: 'rectangular',
    width: 130,
    depth: 130,
    height: 130,
    heatedBed: true,
    nozzleSize: 0.4,
    filamentDiameter: 1.75,
    maxAcceleration: 1000,
    startGcode: `G28 ; Home all axes
G1 Z15.0 F2000 ; Move platform down 15mm
G92 E0 ; Zero extruder
G1 F200 E3 ; Prime nozzle
G92 E0 ; Zero extruder`,
    endGcode: `M104 S0 ; Extruder heater off
M140 S0 ; Heated bed off
G92 E1 ; Set E to 1
G1 E-1 F300 ; Retract filament
G28 X0 Y0 Z0 ; Return home
M84 ; Disable steppers`,
    qualities: {
      fast: {
        name: 'Fast Print (Быстрая)',
        layerHeight: 0.2,
        initialLayerHeight: 0.2,
        wallThickness: 1.0,
        topBottomThickness: 0.8,
        infillDensity: 15,
        printSpeed: 60,
        travelSpeed: 60,
        retractionDistance: 6.0,
        retractionSpeed: 50
      },
      standard: {
        name: 'Standard Quality (Стандартная)',
        layerHeight: 0.15,
        initialLayerHeight: 0.2,
        wallThickness: 1.2,
        topBottomThickness: 1.0,
        infillDensity: 20,
        printSpeed: 45,
        travelSpeed: 60,
        retractionDistance: 5.0,
        retractionSpeed: 45
      },
      high: {
        name: 'High Quality (Высокое качество)',
        layerHeight: 0.1,
        initialLayerHeight: 0.15,
        wallThickness: 1.2,
        topBottomThickness: 1.2,
        infillDensity: 25,
        printSpeed: 30,
        travelSpeed: 50,
        retractionDistance: 4.5,
        retractionSpeed: 40
      }
    },
    materials: {
      pla: { name: 'PLA', printTemp: 205, bedTemp: 60, fanSpeed: 100, flow: 100 },
      petg: { name: 'PETG', printTemp: 235, bedTemp: 75, fanSpeed: 50, flow: 98 },
      tpu: { name: 'TPU (Flex)', printTemp: 220, bedTemp: 50, fanSpeed: 100, flow: 105, speedFactor: 0.5 }
    }
  },

  'mooz-2-plus': {
    id: 'mooz-2-plus',
    name: 'Dobot MOOZ-2 PLUS',
    kinematics: 'Cartesian',
    shape: 'rectangular',
    width: 200,
    depth: 200,
    height: 190,
    heatedBed: true,
    nozzleSize: 0.4,
    filamentDiameter: 1.75,
    maxAcceleration: 1000,
    startGcode: `G28 ; Home all axes
G1 Z15.0 F2000 ; Move platform down 15mm
G92 E0 ; Zero extruder
G1 F200 E3 ; Prime nozzle
G92 E0 ; Zero extruder`,
    endGcode: `M104 S0 ; Extruder heater off
M140 S0 ; Heated bed off
G92 E1 ; Set E to 1
G1 E-1 F300 ; Retract filament
G28 X0 Y0 Z0 ; Return home
M84 ; Disable steppers`,
    qualities: {
      fast: {
        name: 'Fast Print (Быстрая)',
        layerHeight: 0.2,
        initialLayerHeight: 0.2,
        wallThickness: 1.0,
        topBottomThickness: 0.8,
        infillDensity: 15,
        printSpeed: 60,
        travelSpeed: 60,
        retractionDistance: 6.0,
        retractionSpeed: 50
      },
      standard: {
        name: 'Standard Quality (Стандартная)',
        layerHeight: 0.15,
        initialLayerHeight: 0.2,
        wallThickness: 1.2,
        topBottomThickness: 1.0,
        infillDensity: 20,
        printSpeed: 45,
        travelSpeed: 60,
        retractionDistance: 5.0,
        retractionSpeed: 45
      },
      high: {
        name: 'High Quality (Высокое качество)',
        layerHeight: 0.1,
        initialLayerHeight: 0.15,
        wallThickness: 1.2,
        topBottomThickness: 1.2,
        infillDensity: 25,
        printSpeed: 30,
        travelSpeed: 50,
        retractionDistance: 4.5,
        retractionSpeed: 40
      }
    },
    materials: {
      pla: { name: 'PLA', printTemp: 205, bedTemp: 60, fanSpeed: 100, flow: 100 },
      petg: { name: 'PETG', printTemp: 235, bedTemp: 75, fanSpeed: 50, flow: 98 },
      tpu: { name: 'TPU (Flex)', printTemp: 220, bedTemp: 50, fanSpeed: 100, flow: 105, speedFactor: 0.5 }
    }
  },

  'mooz-3': {
    id: 'mooz-3',
    name: 'Dobot MOOZ-3 Delta',
    kinematics: 'Delta',
    shape: 'circular',
    width: 100, // Diameter 100mm
    depth: 100,
    height: 100,
    heatedBed: true,
    nozzleSize: 0.4,
    filamentDiameter: 1.75,
    maxAcceleration: 1000,
    startGcode: `G28 ; Delta Home
G1 Z20.0 F3000 ; Lower nozzle
G92 E0
G1 F200 E3 ; Prime
G92 E0`,
    endGcode: `M104 S0 ; Extruder heater off
M140 S0 ; Heated bed off
G92 E1
G1 E-2 F300 ; Retract
G28 ; Home
M84 ; Disable steppers`,
    qualities: {
      fast: {
        name: 'Fast Print (Быстрая)',
        layerHeight: 0.2,
        initialLayerHeight: 0.2,
        wallThickness: 1.0,
        topBottomThickness: 0.8,
        infillDensity: 15,
        printSpeed: 50,
        travelSpeed: 60,
        retractionDistance: 4.0,
        retractionSpeed: 45
      },
      standard: {
        name: 'Standard Quality (Стандартная)',
        layerHeight: 0.15,
        initialLayerHeight: 0.2,
        wallThickness: 1.2,
        topBottomThickness: 1.0,
        infillDensity: 20,
        printSpeed: 40,
        travelSpeed: 50,
        retractionDistance: 4.0,
        retractionSpeed: 45
      },
      high: {
        name: 'High Quality (Высокое качество)',
        layerHeight: 0.1,
        initialLayerHeight: 0.15,
        wallThickness: 1.2,
        topBottomThickness: 1.2,
        infillDensity: 25,
        printSpeed: 25,
        travelSpeed: 40,
        retractionDistance: 3.5,
        retractionSpeed: 40
      }
    },
    materials: {
      pla: { name: 'PLA', printTemp: 205, bedTemp: 60, fanSpeed: 100, flow: 100 }
    }
  }
};
