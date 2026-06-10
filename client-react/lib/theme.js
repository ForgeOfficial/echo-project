'use client';
import { useEffect, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────
// Thème clair / sombre — source de vérité : l'attribut data-theme posé
// sur <html> (cf. script anti-FOUC du layout + ThemeToggle de la navbar).
// Ce module sert aux consommateurs JS du thème : le renderer canvas et
// les couleurs inline du HUD, que le CSS ne peut pas thémer.
// ─────────────────────────────────────────────────────────────────────

export function currentTheme() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// Accents (équipes, bonus) calibrés pour fond noir : les teintes claires
// (blanc, jaune, cyan, vert acide) deviennent des variantes denses en clair.
// Clés = triplets RGB exacts utilisés par shared/modes.js et constants.js.
const LIGHT_ACCENT_REMAP = {
  '255,255,255': '24,24,28',    // blanc (équipe 1v1) → encre
  '255,214,10': '170,128,0',    // jaune (équipe / rafale)
  '100,210,255': '0,122,194',   // cyan (équipe / vitesse)
  '163,230,53': '90,140,10',    // vert acide (nuke)
};

export function themedAccent(rgb, theme = currentTheme()) {
  return theme === 'light' ? (LIGHT_ACCENT_REMAP[rgb] || rgb) : rgb;
}

// Hook React : re-rend le composant quand le thème bascule (le toggle ne
// remonte pas l'arbre, on observe l'attribut directement).
export function useThemeName() {
  const [theme, setTheme] = useState('dark');
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setTheme(el.dataset.theme === 'light' ? 'light' : 'dark');
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return theme;
}

// Palette du rendu canvas de l'arène. En sombre : abysse éclairée à la
// lampe. En clair : brume blanche percée par la lumière — même gameplay,
// ambiance inversée.
export const ARENA_THEMES = {
  dark: {
    ink: '255,255,255',          // traits UI du canvas (cadre, hit-markers)
    core: '#ffffff',             // cœur lumineux des entités / balles
    bg0: '#101013', bg1: '#050506',
    grid: 'rgba(255,255,255,0.03)',
    fog: 'rgba(2,2,4,0.9)',      // voile hors de la lumière
    wall0: '#28282E', wall1: '#161619',
    wallStroke: 'rgba(255,255,255,0.18)',
    vignette: 0.55,
    self: '120,255,180',         // marqueur « c'est toi » (jade)
    sd0: '#170709', sd1: '#080304',  // fond mort subite
    zoneFill: '163,230,53',      // gaz toxique
    zoneEdge: '190,242,100',
    gasText: '212,255,120',
    confetti: '#ffffff',
  },
  light: {
    ink: '20,20,25',
    core: '#0E0E12',
    bg0: '#FFFFFF', bg1: '#F1F1F4',
    grid: 'rgba(20,20,25,0.05)',
    fog: 'rgba(205,205,214,0.93)',
    wall0: '#C9C9D1', wall1: '#A8A8B2',
    wallStroke: 'rgba(20,20,25,0.3)',
    vignette: 0.12,
    self: '0,150,90',
    sd0: '#FFEFEF', sd1: '#FFDFDF',
    zoneFill: '106,150,10',
    zoneEdge: '96,136,8',
    gasText: '88,118,0',
    confetti: '#26262C',
  },
};
