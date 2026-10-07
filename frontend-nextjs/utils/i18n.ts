export type EnglishCopy =
    | "Playground"
    | "Trends"
    | "Settings"
    | "Play"
    | "Characters"
    | "Sent"
    | "Chat"
    | "Send to device"
    | "Upgrade"
    | "No characters found"
    | "credits remaining"
    | "Get unlimited access"
    | "Upgrade to continue"
    | "You can update your settings below"
    | "For children";

const tx = (languageCode: "en-US" | "de-DE" | "es-ES" | "es-AR" | "zh-CN") => {
    return (key: EnglishCopy) => {
        if (!languageCode) {
            languageCode = "en-US";
        }
        if (!key) {
            key = "Playground";
        }
        return {
            "en-US": {
                Playground: "Playground",
                Upgrade: "Upgrade",
                Trends: "Trends",
                Settings: "Settings",
                Play: "Play",
                Characters: "Characters",
                Sent: "Sent",
                Chat: "Chat",
                "Send to device": "Send to device",
                "No characters found": "No characters found",
                "credits remaining": "credits remaining",
                "Get unlimited access": "Get unlimited access",
                "Upgrade to continue": "Upgrade to continue",
                "You can update your settings below":
                    "You can update your settings here",
                "For children": "For children",
            },
            "de-DE": {
                Playground: "Spielplatz",
                Upgrade: "Upgrade",
                Trends: "Trends",
                Settings: "Einstellungen",
                Play: "Spielen",
                Characters: "Charaktere",
                Sent: "Gesendet",
                Chat: "Chat",
                "Send to device": "An Gerät senden",
                "No characters found": "Keine Charaktere gefunden",
                "credits remaining": "Kredite verbleibend",
                "Get unlimited access": "Unbegrenzten Zugang erhalten",
                "Upgrade to continue": "Upgrade um fortzufahren",
                "You can update your settings below":
                    "Hier können Sie Ihre Einstellungen unten aktualisieren",
                "For children": "Für Kinder",
            },
            "es-ES": {
                Playground: "Zona de juegos",
                Upgrade: "Actualizar",
                Trends: "Tendencias",
                Settings: "Configuración",
                Play: "Jugar",
                Characters: "Personajes",
                Sent: "Enviado",
                Chat: "Chat",
                "Send to device": "Enviar al dispositivo",
                "No characters found": "No se encontraron personajes",
                "credits remaining": "Créditos restantes",
                "Get unlimited access": "Obtener acceso ilimitado",
                "Upgrade to continue": "Actualizar para continuar",
                "You can update your settings below":
                    "Aquí puede actualizar su configuración",
                "For children": "Para niños",
            },
            "es-AR": {
                Playground: "Zona de juegos",
                Upgrade: "Actualizar",
                Trends: "Tendencias",
                Settings: "Configuración",
                Play: "Jugar",
                Characters: "Personajes",
                Sent: "Enviado",
                Chat: "Chat",
                "Send to device": "Mandar al dispositivo",
                "No characters found": "No se encontraron personajes",
                "credits remaining": "Créditos restantes",
                "Get unlimited access": "Obtener acceso ilimitado",
                "Upgrade to continue": "Actualizar para continuar",
                "You can update your settings below":
                    "Aquí puede actualizar sus configuraciones",
                "For children": "Para niños",
            },
            "zh-CN": {
                Playground: "游乐场",
                Upgrade: "升级",
                Trends: "趋势",
                Settings: "设置",
                Play: "开始对话",
                Characters: "角色",
                Sent: "发送",
                Chat: "聊天",
                "Send to device": "发送至设备",
                "No characters found": "未找到角色",
                "credits remaining": "剩余积分",
                "Get unlimited access": "获取无限访问",
                "Upgrade to continue": "升级以继续",
                "You can update your settings below": "您可以在此处更新您的设置",
                "For children": "为孩子",
            },
        }[languageCode][key];
    };
};
