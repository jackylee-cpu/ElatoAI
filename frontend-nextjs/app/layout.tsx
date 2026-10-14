import { GeistSans } from "geist/font/sans";
import {
    Inter,
    Baloo_2,
    Comic_Neue,
    Quicksand,
    Fredoka,
    Lora,
    Inter_Tight,
    Borel,
    Silkscreen,
    Luckiest_Guy,
} from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Metadata, Viewport } from "next";
import NextTopLoader from "nextjs-toploader";
import { Karla } from "next/font/google";

const karla = Karla({
	subsets: ["latin"],
	variable: "--font-karla",
});


const inter = Inter({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-inter",
});

const inter_tight = Inter_Tight({
    weight: ["500", "600", "700"],
    style: ["normal", "italic"],
    subsets: ["latin"],
    variable: "--font-inter-tight",
    display: "swap",
});

const baloo2 = Baloo_2({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-baloo2",
});

const comicNeue = Comic_Neue({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-comic-neue",
    weight: ["300", "400", "700"],
});

const quicksand = Quicksand({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-quicksand",
});

const fredoka = Fredoka({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-fredoka",
});

const lora = Lora({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-lora",
});

const borel = Borel({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-borel",
    weight: ["400"],
});

const silkscreen = Silkscreen({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-silkscreen",
    weight: ["400"],
});

const luckiestGuy = Luckiest_Guy({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-luckiest-guy",
    weight: ["400"],
});

const fonts = `${inter.variable} ${inter_tight.variable} ${baloo2.variable} ${comicNeue.variable} ${quicksand.variable} ${fredoka.variable} ${lora.variable} ${karla.variable} ${borel.variable} ${silkscreen.variable} ${luckiestGuy.variable}`;

const defaultUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

export const metadata: Metadata = {
    metadataBase: new URL(defaultUrl),
    title: {
        default: "AI Buddy",
        template: "%s | AI Buddy",
    },
    applicationName: "AI Buddy",
    description:
        "A voice companion toy for young children. Parents pick the character and look after the device here.",
    keywords: [
        "AI toy",
        "AI companion",
        "Cantonese",
        "children",
        "voice assistant",
        "AI Buddy",
        "conversational AI",
    ],
    openGraph: {
        title: "AI Buddy",
        description:
            "A voice companion toy for young children. Parents pick the character and look after the device here.",
        siteName: "AI Buddy",
        locale: "zh-HK",
        type: "website",
    },
    robots: {
        index: false,
        follow: false,
    },
    formatDetection: {
        telephone: false,
    },
    appleWebApp: {
        capable: true,
        title: "AI Buddy",
        statusBarStyle: "black-translucent",
    },
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
};

export default async function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html
            lang="en"
            className={`${GeistSans.className} h-full ${fonts}`}
            suppressHydrationWarning
        >
            <body className="bg-background text-foreground flex flex-col min-h-screen bg-gray-50 font-karla">
                <NextTopLoader showSpinner={false} color="#facc15" />
                <main className="flex-grow mx-auto w-full flex flex-col">
                    {children}
                </main>
                <Toaster />
            </body>
        </html>
    );
}
