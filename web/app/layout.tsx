import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'cui-control-plane — run it in the browser',
  description:
    'A hosted demo of cui-control-plane: run the real tool against the bundled synthetic fixtures and see one control inventory, the five NDAA regimes attached as crosswalk edges, the SPRS score derived from assertion records, and the emitted OSCAL O1-O5 package.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
