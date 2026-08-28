import Link from "next/link"
import { ChevronRight, Home } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createClient } from "@/utils/supabase/server"
import { getAllPersonalities } from "@/db/personalities"
import { CharacterShowcase } from "./components/LandingPage/CharacterShowcase";
import { CreateCharacterShowcase } from "./components/LandingPage/CreateCharacterShowcase";
import Image from "next/image";

export default async function LandingPage() {
  const supabase = createClient();

  const allPersonalities = await getAllPersonalities(supabase);
  const adultPersonalities = allPersonalities.filter((personality) => !personality.is_story && !personality.is_child_voice);
  return (
    <div className="flex min-h-screen flex-col bg-[#FCFAFF]">
      <main className="flex-1">
        <section className="w-full py-12 md:py-20">
          <div className="container px-4 md:px-6 max-w-screen-lg mx-auto">
            <div className="grid gap-6 lg:grid-cols-1 lg:gap-12 items-center">
              <div className="flex flex-col items-center justify-center space-y-4">
                <h1 className="text-2xl text-center md:text-3xl font-bold font-luckiestGuy tracking-widest flex flex-row items-center justify-center gap-2">
                  <Image src="/logos/elato.png" alt="Elato Logo" width={40} height={40} />
                  <span className="mt-3">Elato</span>
                </h1>
                <h1 className="text-5xl text-center md:text-6xl font-bold tracking-tight text-purple-900" style={{ lineHeight: '1.2' }}>
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-600 to-pink-500">
                  Realtime, Conversational AI
                  </span>{" "} on ESP32 with Arduino and Edge Functions
                </h1>

                <p className="text-xl text-gray-600 text-center max-w-[600px]">
                  Attach your <span className="font-silkscreen mx-1">Elato</span> device to any toy or plushie and watch them become AI characters you can talk
                  to!
                </p>

                <div className="flex flex-col gap-4  sm:gap-8 pt-4">
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Link href="/home">
                      <Button
                        size="lg"
                        className="w-full sm:w-auto flex-row items-center gap-2 bg-gradient-to-r from-purple-600 to-pink-500 text-white border-0 text-lg h-14"
                      >
                        <span>See Characters</span>
                        <Home className="ml-2 h-5 w-5" />
                      </Button>
                    </Link>
                    
                    <Link href="/login">
                      <Button
                        size="lg"
                        variant="outline"
                        className="w-full sm:w-auto flex-row items-center gap-2 border-purple-600 text-purple-600 hover:bg-purple-50 text-lg h-14"
                      >
                        <span>Get Started</span>
                        <ChevronRight className="ml-2 h-5 w-5" />
                      </Button>
                    </Link>
                  </div>
                </div>

                <div className="flex flex-row gap-2 items-center"> 
                  <div className="w-full py-8">
                    <h3 className="text-center text-sm font-medium text-gray-500 mb-6">POWERED BY</h3>
                    <div className="flex flex-wrap justify-center items-center gap-12">
                      <a href="https://vercel.com" target="_blank" rel="noopener noreferrer" className="transition-all">
                        <Image src="/logos/vercel.png" alt="Vercel" width={100} height={24} style={{ height: '36px', width: 'auto' }} />
                      </a>
                      <a href="https://deno.com" target="_blank" rel="noopener noreferrer" className="transition-all">
                        <Image src="/logos/deno.png" alt="Deno" width={100} height={24} style={{ height: '36px', width: 'auto' }} />
                      </a>
                      <a href="https://supabase.com" target="_blank" rel="noopener noreferrer" className="transition-all">
                        <Image src="/logos/supabase.png" alt="Supabase" width={100} height={24} style={{ height: '48px', width: 'auto' }} />
                      </a>
                      <a href="https://arduino.cc" target="_blank" rel="noopener noreferrer" className="transition-all">
                        <Image src="/logos/arduino.png" alt="Arduino" width={100} height={24} style={{ height: '36px', width: 'auto' }} />
                      </a>
                      <a href="https://espressif.com" target="_blank" rel="noopener noreferrer" className="transition-all">
                        <Image src="/logos/espressif.png" alt="Espressif ESP32" width={100} height={24} style={{ height: '36px', width: 'auto' }} />
                      </a>
                      <a href="https://platformio.org" target="_blank" rel="noopener noreferrer" className="transition-all">
                        <Image src="/logos/platformio.png" alt="PlatformIO" width={100} height={24} style={{ height: '36px', width: 'auto' }} />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

                <section className="w-full py-12 bg-gradient-to-b from-purple-50 to-white">
          <div className="container px-4 md:px-6">
            <div className="text-center mb-10">
              <h2 className="text-3xl md:text-4xl font-bold mb-6 text-gray-800">
                Super Simple to Use
              </h2>
              <p className="text-lg text-gray-600 mt-2">Just 3 easy steps to epic conversations</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="bg-white rounded-xl p-6 shadow-lg border border-purple-100 transform transition-transform hover:scale-105">
                <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mb-4">
                  <span className="text-xl font-bold text-purple-600">1</span>
                </div>
                <h3 className="text-xl font-bold text-purple-900 mb-2">Attach</h3>
                <p className="text-gray-600">Attach the Elato device to any toy or plushie</p>
              </div>

              <div className="bg-white rounded-xl p-6 shadow-lg border border-purple-100 transform transition-transform hover:scale-105">
                <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mb-4">
                  <span className="text-xl font-bold text-purple-600">2</span>
                </div>
                <h3 className="text-xl font-bold text-purple-900 mb-2">Configure</h3>
                <p className="text-gray-600">Use our <a href="/home" className="text-purple-600">web app</a> to set up your toy's personality</p>
              </div>

              <div className="bg-white rounded-xl p-6 shadow-lg border border-purple-100 transform transition-transform hover:scale-105">
                <div className="w-12 h-12 bg-purple-100 rounded-full flex items-center justify-center mb-4">
                  <span className="text-xl font-bold text-purple-600">3</span>
                </div>
                <h3 className="text-xl font-bold text-purple-900 mb-2">Talk</h3>
                <p className="text-gray-600">Start chatting with your toy - it's that simple!</p>
              </div>
            </div>
          </div>
        </section>


        <CharacterShowcase allPersonalities={adultPersonalities} />

        <CreateCharacterShowcase />
      </main>
    </div>
  )
}
