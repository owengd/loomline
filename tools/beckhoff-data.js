// Beckhoff EtherCAT I/O for the Loomline library. Terminal point assignments were taken from
// Beckhoff's documentation (infosys.beckhoff.com and the EL10xx, EL20xx, EL18xx/EL28xx, EL30xx,
// EL31xx, EL32xx, EL3356, EL40xx, EL26xx and EL9xxx manuals), checked November 2026.
// Pin names: DIn / DOn digital, AIn / AIn+ / AIn- analog in, AOn analog out, RELn relay,
// R / RL for RTDs, UD / UREF / UV for bridges. Supply pins: +24V, 0V, GND, PE, SH (shield), NC.
// ebus: E-bus current in mA where Beckhoff states it (blank = not yet looked up).
const P = (s) => s.split(',').map((x) => x.trim());
module.exports = {
  source: 'Beckhoff Information System and EtherCAT terminal manuals, checked November 2026',
  parts: [
    // ---- controller (Industrial PC). Not an E-bus device: EtherCAT runs from a LAN port to the EK1100.
    { code: 'C6017-0030', type: 'IPC', ipc: true,
      desc: 'Ultra-compact Industrial PC, Intel Atom x6214RE 2-core 1.4 GHz (option x6416RE 4-core), 4 GB DDR4, 40 GB M.2 SSD, 24 V DC, TwinCAT 3 platform level 40 (50 with 4-core)',
      signal: '24 V DC on X101 (at least 22 V at the plug), 2x2-pin plug 8 A, max 1.5 mm2',
      power: [['1', 'PC-ON', 'input'], ['2', 'P-S', 'output'], ['3', '0V', 'passive'], ['4', '+24V', 'passive'], ['PE', 'PE', 'passive']],
      ports: [['X102', 'LAN1 2.5G'], ['X103', 'LAN2 2.5G'], ['X104', 'DP'], ['X105', 'USB 3.1'], ['X106', 'USB 3.1'],
        ['X201', 'LAN3 (opt)'], ['X202', 'LAN4 (opt)'], ['X203', 'USB 3.0 (opt)'], ['X204', 'USB 3.0 (opt)']],
      options: 'C9900-E320 adds X201/X202 LAN + X203/X204 USB; C9900-E311 2 x RS232; C9900-U215 1 s UPS; C9900-C591 4-core + 8 GB',
      datasheet: 'https://www.beckhoff.com/c6017' },
    // ---- coupler and system terminals
    { code: 'EK1100', type: 'COUPLER', desc: 'EtherCAT Coupler for EtherCAT Terminals (E-bus), supplies up to 2 A on the E-bus', signal: 'Us 24 V coupler supply, Up 24 V power contacts', pins: P('Us +24V, Up +24V, Up 0V, PE, Us 0V, Up +24V, Up 0V, PE'), extra: [['X1', 'ECAT IN'], ['X2', 'ECAT OUT']], ebusSupply: 2000 },
    { code: 'EL9100', type: 'SUPPLY', desc: 'Potential supply terminal, 24 V DC (feeds the power contacts)', signal: '24 V DC', pins: P('NC, +24V, 0V, PE, NC, +24V, 0V, PE') },
    { code: 'EL9110', type: 'SUPPLY', desc: 'Potential supply terminal, 24 V DC, with diagnostics', signal: '24 V DC', pins: P('NC, +24V, 0V, PE, NC, +24V, 0V, PE') },
    { code: 'EL9400', type: 'SUPPLY', desc: 'E-bus power supply terminal (2 A) with refresh of the power contacts', signal: '24 V DC in, 5 V / 2 A E-bus', pins: P('Us +24V, +24V, 0V, PE, Us 0V, +24V, 0V, PE'), ebusSupply: 2000 },
    { code: 'EL9410', type: 'SUPPLY', desc: 'E-bus power supply terminal (2 A) with diagnostics and refresh of the power contacts', signal: '24 V DC in, 5 V / 2 A E-bus', pins: P('Us +24V, +24V, 0V, PE, Us 0V, +24V, 0V, PE'), ebusSupply: 2000 },
    // ---- digital input
    { code: 'EL1002', type: 'DI', desc: '2-channel digital input, 24 V DC, 3 ms filter', signal: '24 V DC, type 1/3, 3 ms', pins: P('DI1, +24V, 0V, PE, DI2, +24V, 0V, PE') },
    { code: 'EL1004', type: 'DI', desc: '4-channel digital input, 24 V DC, 3 ms filter', signal: '24 V DC, type 1/3, 3 ms', pins: P('DI1, +24V, +24V, DI3, DI2, +24V, +24V, DI4') },
    { code: 'EL1008', type: 'DI', desc: '8-channel digital input, 24 V DC, 3 ms filter', signal: '24 V DC, type 1/3, 3 ms', pins: P('DI1, DI3, DI5, DI7, DI2, DI4, DI6, DI8'), ebus: 90 },
    { code: 'EL1809', type: 'DI', desc: '16-channel digital input, 24 V DC, 3 ms filter (HD, 16 terminal points)', signal: '24 V DC, type 1/3, 3 ms', pins: P('DI1, DI2, DI3, DI4, DI5, DI6, DI7, DI8, DI9, DI10, DI11, DI12, DI13, DI14, DI15, DI16') },
    { code: 'EL1819', type: 'DI', desc: '16-channel digital input, 24 V DC, 10 µs filter (HD, 16 terminal points)', signal: '24 V DC, type 1/3, 10 µs', pins: P('DI1, DI2, DI3, DI4, DI5, DI6, DI7, DI8, DI9, DI10, DI11, DI12, DI13, DI14, DI15, DI16') },
    { code: 'EL1889', type: 'DI', desc: '16-channel digital input, 24 V DC, ground switching, 3 ms filter (HD)', signal: '24 V DC, ground switching, 3 ms', pins: P('DI1, DI2, DI3, DI4, DI5, DI6, DI7, DI8, DI9, DI10, DI11, DI12, DI13, DI14, DI15, DI16') },
    { code: 'EL1859', type: 'DIO', desc: '8-channel digital input + 8-channel digital output, 24 V DC, 0.5 A (HD)', signal: 'In 24 V DC 3 ms; out 24 V DC 0.5 A', pins: P('DI1, DI2, DI3, DI4, DI5, DI6, DI7, DI8, DO1, DO2, DO3, DO4, DO5, DO6, DO7, DO8') },
    // ---- digital output
    { code: 'EL2002', type: 'DO', desc: '2-channel digital output, 24 V DC, 0.5 A', signal: '24 V DC, 0.5 A', pins: P('DO1, +24V, 0V, PE, DO2, +24V, 0V, PE') },
    { code: 'EL2004', type: 'DO', desc: '4-channel digital output, 24 V DC, 0.5 A', signal: '24 V DC, 0.5 A', pins: P('DO1, 0V, 0V, DO3, DO2, 0V, 0V, DO4') },
    { code: 'EL2008', type: 'DO', desc: '8-channel digital output, 24 V DC, 0.5 A', signal: '24 V DC, 0.5 A', pins: P('DO1, DO3, DO5, DO7, DO2, DO4, DO6, DO8') },
    { code: 'EL2022', type: 'DO', desc: '2-channel digital output, 24 V DC, 2 A', signal: '24 V DC, 2 A', pins: P('DO1, +24V, 0V, PE, DO2, +24V, 0V, PE') },
    { code: 'EL2024', type: 'DO', desc: '4-channel digital output, 24 V DC, 2 A', signal: '24 V DC, 2 A', pins: P('DO1, 0V, 0V, DO3, DO2, 0V, 0V, DO4') },
    { code: 'EL2124', type: 'DO', desc: '4-channel digital output, 5 V DC CMOS', signal: '5 V DC, ±20 mA', pins: P('DO1, +5V, 0V, DO3, DO2, +5V, 0V, DO4') },
    { code: 'EL2622', type: 'RELAY', desc: '2-channel relay output, make contacts, 230 V AC / 30 V DC, 5 A, no power contacts', signal: 'NO contact, 230 V AC / 30 V DC, 5 A', pins: P('REL1 NO, REL1 C, NC, PE, REL2 NO, REL2 C, NC, PE') },
    { code: 'EL2808', type: 'DO', desc: '8-channel digital output, 24 V DC, 0.5 A, with 0 V for each channel (HD)', signal: '24 V DC, 0.5 A', pins: P('DO1, DO2, DO3, DO4, DO5, DO6, DO7, DO8, 0V, 0V, 0V, 0V, 0V, 0V, 0V, 0V') },
    { code: 'EL2809', type: 'DO', desc: '16-channel digital output, 24 V DC, 0.5 A (HD)', signal: '24 V DC, 0.5 A', pins: P('DO1, DO2, DO3, DO4, DO5, DO6, DO7, DO8, DO9, DO10, DO11, DO12, DO13, DO14, DO15, DO16') },
    { code: 'EL2838', type: 'DO', desc: '8-channel digital output, 24 V DC, 2 A, with channel diagnostics (HD, 16 terminal points; 0 V points linked to the 0 V power contact)', signal: '24 V DC, 2 A per channel (10 A total), high-side', pins: P('DO1, DO2, DO3, DO4, DO5, DO6, DO7, DO8, 0V, 0V, 0V, 0V, 0V, 0V, 0V, 0V'), ebus: 85 },
    { code: 'EL2535', type: 'PWM', head: '2 × PWM out, 2 × DI', desc: '2-channel PWM output, 24 V DC, 1 A, current-controlled, for single and double-coil proportional valves; 2 digital 24 V inputs', signal: '±1 A per channel, 30 kHz PWM; coil A across A1/A2, coil B across B1/B2', pins: P('A1, B1, 0V, DI1, A2, B2, 0V, DI2'), ebus: 110 },
    // ---- analog input
    { code: 'EL3001', type: 'AI', desc: '1-channel analog input, ±10 V, single-ended, 12 bit', signal: '±10 V, single-ended, 12 bit', pins: P('AI1, 0V, GND, SH, NC, +24V, GND, SH') },
    { code: 'EL3002', type: 'AI', desc: '2-channel analog input, ±10 V, single-ended, 12 bit', signal: '±10 V, single-ended, 12 bit', pins: P('AI1, 0V, GND, SH, AI2, +24V, GND, SH') },
    { code: 'EL3004', type: 'AI', desc: '4-channel analog input, ±10 V, single-ended, 12 bit', signal: '±10 V, single-ended, 12 bit', pins: P('AI1, GND, AI3, GND, AI2, GND, AI4, GND') },
    { code: 'EL3008', type: 'AI', desc: '8-channel analog input, ±10 V, single-ended, 12 bit', signal: '±10 V, single-ended, 12 bit', pins: P('AI1, AI3, AI5, AI7, AI2, AI4, AI6, AI8') },
    { code: 'EL3012', type: 'AI', desc: '2-channel analog input, 0…20 mA, differential, 12 bit', signal: '0…20 mA, differential, 12 bit', pins: P('AI1+, AI1-, GND, SH, AI2+, AI2-, GND, SH') },
    { code: 'EL3014', type: 'AI', desc: '4-channel analog input, 0…20 mA, differential, 12 bit', signal: '0…20 mA, differential, 12 bit', pins: P('AI1+, AI1-, AI3+, AI3-, AI2+, AI2-, AI4+, AI4-') },
    { code: 'EL3021', type: 'AI', desc: '1-channel analog input, 4…20 mA, differential, 12 bit', signal: '4…20 mA, differential, 12 bit', pins: P('AI1+, AI1-, GND, SH, NC, NC, GND, SH') },
    { code: 'EL3022', type: 'AI', desc: '2-channel analog input, 4…20 mA, differential, 12 bit', signal: '4…20 mA, differential, 12 bit', pins: P('AI1+, AI1-, GND, SH, AI2+, AI2-, GND, SH') },
    { code: 'EL3024', type: 'AI', desc: '4-channel analog input, 4…20 mA, differential, 12 bit', signal: '4…20 mA, differential, 12 bit', pins: P('AI1+, AI1-, AI3+, AI3-, AI2+, AI2-, AI4+, AI4-') },
    { code: 'EL3054', type: 'AI', desc: '4-channel analog input, 4…20 mA, single-ended, 12 bit, 24 V supply for 2-wire sensors', signal: '4…20 mA, single-ended, 12 bit', pins: P('AI1, +24V, AI3, +24V, AI2, +24V, AI4, +24V') },
    { code: 'EL3078', type: 'AI', desc: '8-channel analog input, multi-function ±10 V / ±20 mA (0/4…20 mA), 16 bit, single-ended (HD, 16 terminal points)', signal: '-10/0…+10 V on Un, -20/0/+4…+20 mA on In, 16 bit, single-ended', pins: P('AI1 U, AI2 U, AI3 U, AI4 U, AI5 U, AI6 U, AI7 U, AI8 U, AI1 I, AI2 I, AI3 I, AI4 I, AI5 I, AI6 I, AI7 I, AI8 I'), ebus: 90 },
    { code: 'EL3064', type: 'AI', desc: '4-channel analog input, 0…10 V, single-ended, 12 bit', signal: '0…10 V, single-ended, 12 bit', pins: P('AI1, GND, AI3, GND, AI2, GND, AI4, GND') },
    { code: 'EL3101', type: 'AI', desc: '1-channel analog input, ±10 V, differential, 16 bit', signal: '±10 V, differential, 16 bit', pins: P('AI1+, AI1-, GND, SH, NC, NC, GND, SH') },
    { code: 'EL3102', type: 'AI', desc: '2-channel analog input, ±10 V, differential, 16 bit', signal: '±10 V, differential, 16 bit', pins: P('AI1+, AI1-, GND, SH, AI2+, AI2-, GND, SH') },
    { code: 'EL3104', type: 'AI', desc: '4-channel analog input, ±10 V, differential, 16 bit', signal: '±10 V, differential, 16 bit', pins: P('AI1+, AI1-, AI3+, AI3-, AI2+, AI2-, AI4+, AI4-') },
    { code: 'EL3111', type: 'AI', desc: '1-channel analog input, 0…20 mA, differential, 16 bit', signal: '0…20 mA, differential, 16 bit', pins: P('AI1+, AI1-, GND, SH, NC, NC, GND, SH') },
    { code: 'EL3112', type: 'AI', desc: '2-channel analog input, 0…20 mA, differential, 16 bit', signal: '0…20 mA, differential, 16 bit', pins: P('AI1+, AI1-, GND, SH, AI2+, AI2-, GND, SH') },
    { code: 'EL3114', type: 'AI', desc: '4-channel analog input, 0…20 mA, differential, 16 bit', signal: '0…20 mA, differential, 16 bit', pins: P('AI1+, AI1-, AI3+, AI3-, AI2+, AI2-, AI4+, AI4-') },
    { code: 'EL3121', type: 'AI', desc: '1-channel analog input, 4…20 mA, differential, 16 bit', signal: '4…20 mA, differential, 16 bit', pins: P('AI1+, AI1-, GND, SH, NC, NC, GND, SH') },
    { code: 'EL3122', type: 'AI', desc: '2-channel analog input, 4…20 mA, differential, 16 bit', signal: '4…20 mA, differential, 16 bit', pins: P('AI1+, AI1-, GND, SH, AI2+, AI2-, GND, SH') },
    { code: 'EL3124', type: 'AI', desc: '4-channel analog input, 4…20 mA, differential, 16 bit', signal: '4…20 mA, differential, 16 bit', pins: P('AI1+, AI1-, AI3+, AI3-, AI2+, AI2-, AI4+, AI4-') },
    { code: 'EL3202', type: 'RTD', desc: '2-channel analog input, resistance thermometer (Pt100, Pt1000…), 16 bit; bridge R+ and RL+ for 2-wire', signal: 'RTD, 2- or 3-wire, 16 bit', pins: P('R1+, RL1+, R1-, SH, R2+, RL2+, R2-, SH') },
    { code: 'EL3356', type: 'BRIDGE', desc: '1-channel precise load cell analysis (resistor bridge), 16 bit', signal: 'Full bridge, 4- or 6-wire, 16 bit', pins: P('UD+, UD-, UV-, SH, UREF+, UREF-, UV+, SH') },
    // ---- analog output
    { code: 'EL4002', type: 'AO', desc: '2-channel analog output, 0…10 V, 12 bit', signal: '0…10 V, 12 bit', pins: P('AO1, NC, 0V, SH, AO2, NC, 0V, SH') },
    { code: 'EL4004', type: 'AO', desc: '4-channel analog output, 0…10 V, 12 bit', signal: '0…10 V, 12 bit', pins: P('AO1, 0V, AO3, 0V, AO2, 0V, AO4, 0V') },
    { code: 'EL4008', type: 'AO', desc: '8-channel analog output, 0…10 V, 12 bit', signal: '0…10 V, 12 bit', pins: P('AO1, AO3, AO5, AO7, AO2, AO4, AO6, AO8') },
    { code: 'EL4012', type: 'AO', desc: '2-channel analog output, 0…20 mA, 12 bit', signal: '0…20 mA, 12 bit', pins: P('AO1, +24V, 0V, SH, AO2, +24V, 0V, SH') },
    { code: 'EL4014', type: 'AO', desc: '4-channel analog output, 0…20 mA, 12 bit', signal: '0…20 mA, 12 bit', pins: P('AO1, 0V, AO3, 0V, AO2, 0V, AO4, 0V') },
    { code: 'EL4022', type: 'AO', desc: '2-channel analog output, 4…20 mA, 12 bit', signal: '4…20 mA, 12 bit', pins: P('AO1, +24V, 0V, SH, AO2, +24V, 0V, SH') },
    { code: 'EL4024', type: 'AO', desc: '4-channel analog output, 4…20 mA, 12 bit', signal: '4…20 mA, 12 bit', pins: P('AO1, 0V, AO3, 0V, AO2, 0V, AO4, 0V') },
    { code: 'EL4032', type: 'AO', desc: '2-channel analog output, ±10 V, 12 bit', signal: '±10 V, 12 bit', pins: P('AO1, NC, 0V, SH, AO2, NC, 0V, SH') },
    { code: 'EL4034', type: 'AO', desc: '4-channel analog output, ±10 V, 12 bit', signal: '±10 V, 12 bit', pins: P('AO1, 0V, AO3, 0V, AO2, 0V, AO4, 0V') },
    { code: 'EL4038', type: 'AO', desc: '8-channel analog output, ±10 V, 12 bit', signal: '±10 V, 12 bit', pins: P('AO1, AO3, AO5, AO7, AO2, AO4, AO6, AO8') },
    // ---- communication
    { code: 'EL6021', type: 'SERIAL', desc: 'Serial interface, 1 channel, RS422/RS485, up to 115.2 kbaud (RS485: link TxD+ to RxD+ and TxD- to RxD-)', signal: 'RS422 full duplex / RS485 half duplex, up to 115.2 kbaud', pins: P('TxD+, RxD+, GND, SH, TxD-, RxD-, GND, SH'), ebus: 170 },
    { code: 'EL6751', type: 'CAN', head: 'CANopen master', desc: 'CANopen master/slave terminal, 9-pin D-sub (pins: 2 CAN_L, 7 CAN_H, 3 and 6 CAN GND, 9 optional aux supply up to 30 V; shield via the plug housing). 24 mm wide', signal: 'CANopen, D-sub 9-pin (CiA 303-1), galvanically isolated', pins: P('NC, CAN_L, CAN_GND, NC, NC, CAN_GND, CAN_H, NC, V+, SH'), nums: P('1, 2, 3, 4, 5, 6, 7, 8, 9, SH'), ebus: 230 }
  ]
};
