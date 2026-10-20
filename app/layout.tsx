import type {Metadata} from 'next';
import './globals.css'; // Global styles

export const metadata: Metadata = {
  title: 'Battle Royale FPS',
  description: 'Full-bleed 3D battle royale tactical shooter featuring test range and harbor terrain, procedural IK-rigged dummies, customizable abilities, and multi-tier arsenal.',
  openGraph: {
    title: 'Battle Royale FPS',
    description: 'Full-bleed 3D battle royale tactical shooter featuring test range and harbor terrain, procedural IK-rigged dummies, customizable abilities, and multi-tier arsenal.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Battle Royale FPS',
    description: 'Full-bleed 3D battle royale tactical shooter featuring test range and harbor terrain, procedural IK-rigged dummies, customizable abilities, and multi-tier arsenal.',
  },
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en">
      <body suppressHydrationWarning className="overflow-hidden m-0 p-0 select-none touch-none bg-[#dfe5ec]">
        {children}
      </body>
    </html>
  );
}
