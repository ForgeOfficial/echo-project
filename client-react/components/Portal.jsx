'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Rend ses enfants directement dans <body>, hors du flux de `.page-wrap`.
// Sans ça, une modale héritait du contexte d'empilement de `.page-wrap` et
// passait sous la navbar (cf. z-index). Le portail garantit qu'elle flotte
// au-dessus de toute l'interface.
export default function Portal({ children }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  if (!mounted) return null;
  return createPortal(children, document.body);
}
