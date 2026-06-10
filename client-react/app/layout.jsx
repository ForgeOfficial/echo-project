import './globals.css';
import { AppProvider } from '../context/AppContext';
import Navbar from '../components/Navbar';

export const metadata = {
  title: 'ECHO — Sonar Duel',
  description: "L'arène est noire. Émets un ping. Traque ton adversaire.",
};

// Mobile : on bloque le zoom/scroll parasites pendant le jeu et on étend le
// rendu sous les encoches (safe-area) pour les contrôles tactiles plein écran.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#060607',
};

// Appliqué avant le premier rendu pour éviter le flash de thème (FOUC).
// Sombre par défaut (identité du jeu) ; « light » uniquement si choisi.
const themeInit = `try{if(localStorage.getItem('echo-theme')==='light')document.documentElement.dataset.theme='light'}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <AppProvider>
          <Navbar />
          <main className="page-wrap">{children}</main>
        </AppProvider>
      </body>
    </html>
  );
}
