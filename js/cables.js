/* Loomline cable catalogue: the cables offered in the CABLE dialog. Type is core size and core
 * count; desc is shown beside the product code. Add a line per cable; the app also offers any
 * cable already used in the open project.
 * MIL-DTL-27500 / NEMA WC27500 codes: M27500-<AWG>-<wire>-<cores><shield><jacket>.
 *   Wire TG = AS22759/18 ETFE, tin-plated copper, 600 V, 150 °C.
 *   Wire SB = AS22759/32 crosslinked ETFE, tin-plated copper, 600 V, 150 °C conductor.
 *   Shield T = tin-plated copper braid, U = no shield. Jacket 14 = white ETFE (150 °C),
 *   23 = white irradiated (crosslinked) ETFE (200 °C), 00 = no jacket (RSCC NEMA WC 27500 sheet).
 * Core colours: M27500 identification code "-" = white base with coloured stripes (Standard Wire
 * and WireMasters M27500 guides). MX100Q colours are from the MX100Q-24CF data sheet (WireMasters):
 * component 1 red and blue, component 2 yellow and green; check the 26 AWG reel.
 * Sources: Cambridge Technologies order 123641 (AC75) and quotation 117177 (14 Oct 2026); data
 * sheets supplied by Gareth (21 Nov 2026): RSCC SAE AS22759/32 & 33 and NEMA WC 27500, Thermax
 * MaxFlite 100 Base-T and MIL-C-17, the "Ampacity" chart (2022), plus TE 2485634-1. */
(function (root) {
  'use strict';
  // M27500 identification code "-" (no letter before the AWG): conductor 1 plain white, the rest
  // white with a coloured stripe, in this order (Table III A / A-1). The braid shield is listed too.
  const STRIPES = ['White', 'White/Blue stripe', 'White/Orange stripe', 'White/Green stripe', 'White/Red stripe', 'White/Black stripe', 'White/Yellow stripe', 'White/Violet stripe', 'White/Grey stripe', 'White/Brown stripe'];
  const m27500 = (n, screened) => STRIPES.slice(0, n).map((c, i) => `Core ${i + 1} ${c}`).concat(screened ? ['Screen (braid)'] : []);
  const S = 'screened, white ETFE jacket, ETFE cores (AS22759/18), 600 V';
  const X = 'screened, white XL-ETFE jacket, XL-ETFE cores (AS22759/32), 600 V';
  // rating: what the data sheets give (src), and a current per core (amps, ampsNote).
  const NOAMPS = null;
  const TE = 'https://www.te.com/commerce/DocumentDelivery/DDEController?Action=srchrtrv&DocNm=2485634-1_adm_milspec_wire&DocType=Data%20Sheet&DocLang=English&DocFormat=pdf';
  const RSCC = 'https://www.rsccaerodefense.com';
  const THERMAX = 'https://www.thermaxcdt.com';
  const od = (inch) => inch + ' in (' + (inch * 25.4).toFixed(2) + ' mm) max';
  // Current: the supplied "Ampacity" chart (2022): a single 19-strand copper conductor in free air at
  // 30 °C ambient, by the insulation's temperature rating, then derated for cabled conductors:
  // 2-5 conductors 80 %, 6-15 70 %, 16-30 50 %. A cable's cores are a 2-5 group (80 %); several
  // cables run together in a bundle need the bigger derating for the total count.
  const CHART = {
    150: { 14: 45, 16: 34, 18: 25, 20: 18, 22: 13, 24: 10, 26: 7.0 },
    80: { 14: 27, 16: 19, 18: 14, 20: 10, 22: 7.5, 24: 5.5, 26: 4.0 }
  };
  const fmt = (x) => String(Math.round(x * 10) / 10);
  const amps = (awg, rating, cores, extra) => {
    const single = CHART[rating][awg], f = cores > 1 ? 0.8 : 1;
    return {
      amps: fmt(single * f) + ' A per core',
      ampsNote: `${fmt(single)} A for a single ${awg} AWG wire rated ${rating} °C in free air at 30 °C, ×${f === 1 ? 1 : '0.8'} for ${cores} cores in one cable (Ampacity chart 2022). In a bundle of several cables derate for the total: 6–15 conductors 70 %, 16–30 50 % of the single-wire figure.` + (extra ? ' ' + extra : '')
    };
  };
  const OHMS = { 14: '3.06', 16: '4.81', 18: '6.23', 20: '9.88', 22: '16.2', 24: '26.2', 26: '41.3' };
  const wire = (awg, cores, odIn) => Object.assign(amps(awg, 150, cores), { ohms: OHMS[awg] + ' Ω/1000 ft max at 20 °C (per core)', volts: '600 V', temp: '150 °C conductor (−65 °C min)', od: odIn ? od(odIn) : null, src: odIn ? TE : RSCC });
  const U00 = 'unscreened, no jacket (twisted cores), XL-ETFE cores (AS22759/32), 600 V';
  const U23 = 'unscreened, white XL-ETFE jacket, XL-ETFE cores (AS22759/32), 600 V';
  root.CABLE_CATALOGUE = [
    { pn: 'M27500-14-TG-2-T14', type: '14AWG 2 Core', size: '14 AWG', desc: S, cores: m27500(2, true), rating: Object.assign(wire(14, 2), { src: TE }) },
    { pn: 'M27500-14-SB-2-U00', type: '14AWG 2 Core unscreened', size: '14 AWG', desc: U00, cores: m27500(2, false), rating: wire(14, 2) },
    { pn: 'M27500-16-TG-2-T14', type: '16AWG 2 Core', size: '16 AWG', desc: S, cores: m27500(2, true), rating: Object.assign(wire(16, 2), { src: TE }) },
    { pn: 'M27500-16-SB-2-U00', type: '16AWG 2 Core unscreened', size: '16 AWG', desc: U00, cores: m27500(2, false), rating: wire(16, 2) },
    { pn: 'M27500-18-SB-2-T23', type: '18AWG 2 Core', size: '18 AWG', desc: X, cores: m27500(2, true), rating: wire(18, 2, 0.162) },
    { pn: 'M27500-18-SB-2-U00', type: '18AWG 2 Core unscreened', size: '18 AWG', desc: U00, cores: m27500(2, false), rating: wire(18, 2) },
    { pn: 'M27500-20-SB-2-T23', type: '20AWG 2 Core', size: '20 AWG', desc: X, cores: m27500(2, true), rating: wire(20, 2, 0.141) },
    { pn: 'M27500-20-SB-2-U00', type: '20AWG 2 Core unscreened', size: '20 AWG', desc: U00, cores: m27500(2, false), rating: wire(20, 2) },
    { pn: 'M27500-22-SB-2-U00', type: '22AWG 2 Core', size: '22 AWG', desc: U00, cores: m27500(2, false), rating: wire(22, 2) },
    { pn: 'M27500-24-SB-2-T23', type: '24AWG 2 Core', size: '24 AWG', desc: X, cores: m27500(2, true), rating: wire(24, 2, 0.112) },
    { pn: 'M27500-24-SB-2-U23', type: '24AWG 2 Core unscreened', size: '24 AWG', desc: U23, cores: m27500(2, false), rating: wire(24, 2) },
    { pn: 'M27500-24-SB-3-T23', type: '24AWG 3 Core', size: '24 AWG', desc: X, cores: m27500(3, true), rating: wire(24, 3, 0.119) },
    { pn: 'M27500-26-SB-2-T23', type: '26AWG 2 Core', size: '26 AWG', desc: X, cores: m27500(2, true), rating: wire(26, 2) },
    { pn: 'M27500-26-SB-4-T23', type: '26AWG 4 Core', size: '26 AWG', desc: X, cores: m27500(4, true), rating: wire(26, 4, 0.127) },
    { pn: 'MX100Q-26', type: '26AWG 4 Core Ethernet', size: '26 AWG', desc: 'Thermax MaxFlite 100BASE-T Ethernet, shielded quad, transparent blue FEP jacket', cores: ['Pair 1 Red', 'Pair 1 Blue', 'Pair 2 Yellow', 'Pair 2 Green', 'Screen (braid)'],
      rating: Object.assign(amps(26, 150, 4, 'The chart is for copper; these cores are high-strength copper alloy with higher resistance, so treat this as an upper limit. For PoE keep to the PoE standard\'s limits.'), { ohms: null, volts: null, temp: '150 °C', od: '0.138 in (3.50 mm) nominal', other: '100 Ω ±10%; 19-strand silver-plated high-strength copper alloy cores; 10.5 dB/100 ft at 100 MHz', src: THERMAX }) },
    { pn: 'M17/094-RG179', type: 'Coax RG179 75 ohm', size: 'RG179', desc: 'Thermax RGU-179 coax, 75 ohm, 7/38 silver-plated copperweld centre, PTFE, FEP jacket', cores: ['Centre conductor', 'Screen (braid)'],
      rating: { amps: NOAMPS, ampsNote: 'RF coax: no current rating. The centre conductor is copper-covered steel (24.5 Ω/100 ft max), so it is not suited to carrying power.', ohms: '24.5 Ω/100 ft (80.2 Ω/100 m) max, centre conductor', volts: '900 V max working', temp: null, od: '0.100 in (2.54 mm) nominal', other: 'Max power 880 W at 100 MHz, 420 W at 400 MHz, 260 W at 1 GHz', src: THERMAX } },
    { pn: 'LMR-240', type: 'Coax LMR-240 50 ohm', size: 'LMR-240', desc: 'low-loss coax, 50 ohm', cores: ['Centre conductor', 'Screen'],
      rating: { amps: NOAMPS, ampsNote: 'RF coax: no DC current rating published; RF power rating below.', ohms: 'inner 3.2, outer 3.89 Ω/1000 ft', volts: '1500 V DC withstand', temp: '−40 to +85 °C', other: 'RF power 0.26 kW at 900 MHz (40 °C ambient)', src: 'https://www.mouser.com/datasheet/2/18/1/LMR_240-1826522.pdf' } },
    // CAN bus cable (Gareth, 19 Nov 2026). MODDIY's page gives no core colours, shield build or maker;
    // "80?" on the page is taken as 80 °C. Check the core colours on the reel.
    { pn: 'UL2547-USB2-B', type: '24AWG 4 Core USB (CAN)', size: '24 AWG', desc: 'MODDIY shielded 4-wire USB 2.0 cable, UL2547 24AWG/4C, black, 3.6 mm OD, VW-1 FT1',
      cores: ['Core 1', 'Core 2', 'Core 3', 'Core 4', 'Screen'],
      rating: Object.assign(amps(24, 80, 4, 'Uses the 80 °C column (this cable\'s rating) and assumes copper cores.'), { ohms: null, volts: '300 V', temp: '80 °C (shown as “80?” on the page)', src: 'https://www.moddiy.com/products/2495/Shielded-4-Wire-USB-2.0-Cable-Wire-UL2547-24A-4C-Black.html' }) }
  ];

})(typeof globalThis !== 'undefined' ? globalThis : this);
