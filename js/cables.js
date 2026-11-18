/* Loomline cable catalogue: the cables offered in the CABLE dialog. Type is core size and core
 * count; desc is shown beside the product code. Add a line per cable; the app also offers any
 * cable already used in the open project.
 * MIL-DTL-27500 / NEMA WC27500 codes: M27500-<AWG>-<wire>-<cores><shield><jacket>.
 *   Wire TG = AS22759/18 ETFE, tin-plated copper, 600 V, 150 °C.
 *   Wire SB = AS22759/32 crosslinked ETFE, tin-plated copper, 600 V, 150 °C.
 *   Shield T = tin-plated copper braid, U = no shield. Jacket 14 = white ETFE (150 °C),
 *   23 = white crosslinked ETFE (200 °C), 00 = no jacket.
 * Core colours: M27500 identification code "-" = white base with coloured stripes (Standard Wire
 * and WireMasters M27500 guides). MX100Q colours are from the MX100Q-24CF data sheet (WireMasters):
 * component 1 red and blue, component 2 yellow and green; check the 26 AWG reel.
 * Source: Cambridge Technologies order 123641 (AC75), decoded from the NASA NEPP and WireMasters
 * M27500 part-number guides. */
(function (root) {
  'use strict';
  // M27500 identification code "-" (no letter before the AWG): conductor 1 plain white, the rest
  // white with a coloured stripe, in this order (Table III A / A-1). The braid shield is listed too.
  const STRIPES = ['White', 'White/Blue stripe', 'White/Orange stripe', 'White/Green stripe', 'White/Red stripe', 'White/Black stripe', 'White/Yellow stripe', 'White/Violet stripe', 'White/Grey stripe', 'White/Brown stripe'];
  const m27500 = (n, screened) => STRIPES.slice(0, n).map((c, i) => `Core ${i + 1} ${c}`).concat(screened ? ['Screen (braid)'] : []);
  const S = 'screened, white ETFE jacket, ETFE cores (AS22759/18), 600 V';
  const X = 'screened, white XL-ETFE jacket, XL-ETFE cores (AS22759/32), 600 V';
  // rating: what each maker's own data sheet publishes (src). amps stays null where the maker publishes
  // no current rating: none of these makers do; the ratings for aerospace wire live in SAE AS50881
  // (not public), so check against that before relying on a size.
  const NOAMPS = null;
  // TE Connectivity "Mil-Spec Wire and Cable" data sheet 2485634-1 (rev 2503): AS22759/18 and /32
  // conductor resistance (max at 20 °C), 600 V, -65 to +150 °C, and M27500 SB..T23 cable max diameters.
  const TE = 'https://www.te.com/commerce/DocumentDelivery/DDEController?Action=srchrtrv&DocNm=2485634-1_adm_milspec_wire&DocType=Data%20Sheet&DocLang=English&DocFormat=pdf';
  const od = (inch) => inch + ' in (' + (inch * 25.4).toFixed(2) + ' mm) max';
  const wire = (ohms, odIn) => ({ amps: NOAMPS, ohms: ohms + ' Ω/1000 ft max at 20 °C (per core)', volts: '600 V', temp: '−65 to +150 °C', od: odIn ? od(odIn) : null, src: TE });
  const tg = (ohms) => wire(ohms, null);
  const sb = (ohms, odIn) => wire(ohms, odIn);
  root.CABLE_CATALOGUE = [
    { pn: 'M27500-14-TG-2-T14', type: '14AWG 2 Core', size: '14 AWG', desc: S, cores: m27500(2, true), rating: tg('3.06') },
    { pn: 'M27500-16-TG-2-T14', type: '16AWG 2 Core', size: '16 AWG', desc: S, cores: m27500(2, true), rating: tg('4.81') },
    { pn: 'M27500-18-SB-2-T23', type: '18AWG 2 Core', size: '18 AWG', desc: X, cores: m27500(2, true), rating: sb('6.23', 0.162) },
    { pn: 'M27500-20-SB-2-T23', type: '20AWG 2 Core', size: '20 AWG', desc: X, cores: m27500(2, true), rating: sb('9.88', 0.141) },
    { pn: 'M27500-22-SB-2-U00', type: '22AWG 2 Core', size: '22 AWG', desc: 'unscreened, no jacket (twisted cores), XL-ETFE cores (AS22759/32), 600 V', cores: m27500(2, false), rating: sb('16.2') },
    { pn: 'M27500-24-SB-2-T23', type: '24AWG 2 Core', size: '24 AWG', desc: X, cores: m27500(2, true), rating: sb('26.2', 0.112) },
    { pn: 'M27500-24-SB-3-T23', type: '24AWG 3 Core', size: '24 AWG', desc: X, cores: m27500(3, true), rating: sb('26.2', 0.119) },
    { pn: 'M27500-26-SB-4-T23', type: '26AWG 4 Core', size: '26 AWG', desc: X, cores: m27500(4, true), rating: sb('41.3', 0.127) },
    { pn: 'MX100Q-26', type: '26AWG 4 Core Ethernet', size: '26 AWG', desc: 'Maxflite 100BASE-T Ethernet, quad, blue', cores: ['Pair 1 Red', 'Pair 1 Blue', 'Pair 2 Yellow', 'Pair 2 Green', 'Screen (braid)'],
      rating: { amps: NOAMPS, ohms: null, volts: null, temp: '−55 to +150 °C (from the MX100Q-24 sheet; no 26 AWG sheet found)', other: '100 Ω', src: 'https://www.wiremasters.com/product/mx100q-24' } },
    { pn: 'M17/094-RG179', type: 'Coax RG179 75 ohm', size: 'RG179', desc: 'RG179 coax, 75 ohm (ordered as RGU-179)', cores: ['Centre conductor', 'Screen (braid)'],
      rating: { amps: NOAMPS, ohms: null, volts: '1200 max (unit not printed)', temp: null, other: '75 ±3 Ω', src: 'https://www.farnell.com/datasheets/2036673.pdf' } },
    { pn: 'LMR-240', type: 'Coax LMR-240 50 ohm', size: 'LMR-240', desc: 'low-loss coax, 50 ohm', cores: ['Centre conductor', 'Screen'],
      rating: { amps: NOAMPS, ohms: 'inner 3.2, outer 3.89 Ω/1000 ft', volts: '1500 V DC withstand', temp: '−40 to +85 °C', other: 'RF power 0.26 kW at 900 MHz (40 °C ambient)', src: 'https://www.mouser.com/datasheet/2/18/1/LMR_240-1826522.pdf' } },
    // CAN bus cable (Gareth, 19 Nov 2026). MODDIY's page gives no core colours, shield build or maker;
    // "80?" on the page is taken as 80 °C. Check the core colours on the reel.
    { pn: 'UL2547-USB2-B', type: '24AWG 4 Core USB (CAN)', size: '24 AWG', desc: 'MODDIY shielded 4-wire USB 2.0 cable, UL2547 24AWG/4C, black, 3.6 mm OD, VW-1 FT1',
      cores: ['Core 1', 'Core 2', 'Core 3', 'Core 4', 'Screen'],
      rating: { amps: NOAMPS, ohms: null, volts: '300 V', temp: '80 °C (shown as “80?” on the page)', src: 'https://www.moddiy.com/products/2495/Shielded-4-Wire-USB-2.0-Cable-Wire-UL2547-24A-4C-Black.html' } }
  ];

})(typeof globalThis !== 'undefined' ? globalThis : this);
