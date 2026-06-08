import './globals.css';
import { AppProvider } from '../context/AppContext';
import Navbar from '../components/Navbar';

export const metadata = {
  title: 'ECHO — Sonar Duel',
  description: "L'arène est noire. Émets un ping. Traque ton adversaire.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="fr">
      <body>
        <AppProvider>
          <Navbar />
          <main className="page-wrap">{children}</main>
        </AppProvider>
      </body>
    </html>
  );
}
