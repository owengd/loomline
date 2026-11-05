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
  root.CABLE_CATALOGUE = [
    { pn: 'M27500-14-TG-2-T14', type: '14AWG 2 Core', size: '14 AWG', desc: S, cores: m27500(2, true) },
    { pn: 'M27500-16-TG-2-T14', type: '16AWG 2 Core', size: '16 AWG', desc: S, cores: m27500(2, true) },
    { pn: 'M27500-18-SB-2-T23', type: '18AWG 2 Core', size: '18 AWG', desc: X, cores: m27500(2, true) },
    { pn: 'M27500-20-SB-2-T23', type: '20AWG 2 Core', size: '20 AWG', desc: X, cores: m27500(2, true) },
    { pn: 'M27500-22-SB-2-U00', type: '22AWG 2 Core', size: '22 AWG', desc: 'unscreened, no jacket (twisted cores), XL-ETFE cores (AS22759/32), 600 V', cores: m27500(2, false) },
    { pn: 'M27500-24-SB-2-T23', type: '24AWG 2 Core', size: '24 AWG', desc: X, cores: m27500(2, true) },
    { pn: 'M27500-24-SB-3-T23', type: '24AWG 3 Core', size: '24 AWG', desc: X, cores: m27500(3, true) },
    { pn: 'M27500-26-SB-4-T23', type: '26AWG 4 Core', size: '26 AWG', desc: X, cores: m27500(4, true) },
    { pn: 'MX100Q-26', type: '26AWG 4 Core Ethernet', size: '26 AWG', desc: 'Maxflite 100BASE-T Ethernet, quad, blue', cores: ['Pair 1 Red', 'Pair 1 Blue', 'Pair 2 Yellow', 'Pair 2 Green', 'Screen (braid)'] },
    { pn: 'M17/094-RG179', type: 'Coax RG179 75 ohm', size: 'RG179', desc: 'RG179 coax, 75 ohm (ordered as RGU-179)', cores: ['Centre conductor', 'Screen (braid)'] },
    { pn: 'LMR-240', type: 'Coax LMR-240 50 ohm', size: 'LMR-240', desc: 'low-loss coax, 50 ohm', cores: ['Centre conductor', 'Screen'] }
  ];
})(typeof globalThis !== 'undefined' ? globalThis : this);
