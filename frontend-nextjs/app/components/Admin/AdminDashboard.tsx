"use client";

import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ModelSettingsTab from "./ModelSettingsTab";
import LatencyTab from "./LatencyTab";
import CharactersTab from "./CharactersTab";

interface AdminDashboardProps {
    settings: IVoiceStackSettings;
    turnMetrics: ITurnMetric[];
    personalities: IAdminPersonality[];
}

const AdminDashboard: React.FC<AdminDashboardProps> = ({
    settings,
    turnMetrics,
    personalities,
}) => {
    return (
        <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1">
                <h1 className="text-2xl font-semibold">Admin</h1>
                <p className="text-sm text-muted-foreground">
                    Settings here apply to every session, on the web app and on
                    the toys.
                </p>
            </div>

            <Tabs defaultValue="model" className="w-full">
                <TabsList className="grid w-full max-w-md grid-cols-3">
                    <TabsTrigger value="model">Model</TabsTrigger>
                    <TabsTrigger value="latency">Latency</TabsTrigger>
                    <TabsTrigger value="characters">Characters</TabsTrigger>
                </TabsList>

                <TabsContent value="model" className="mt-4">
                    <ModelSettingsTab settings={settings} />
                </TabsContent>

                <TabsContent value="latency" className="mt-4">
                    <LatencyTab rows={turnMetrics} />
                </TabsContent>

                <TabsContent value="characters" className="mt-4">
                    <CharactersTab personalities={personalities} />
                </TabsContent>
            </Tabs>
        </div>
    );
};

export default AdminDashboard;
