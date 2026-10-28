"use client";

import React, { useState } from "react";
import { createClient } from "@/utils/supabase/client";
import HomePageSubtitles from "./../HomePageSubtitles";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Check, ImagePlus, X } from "lucide-react";
import {
  createPersonality,
  uploadCharacterImage,
  MAX_CHARACTER_IMAGE_BYTES,
} from "@/db/personalities";
import { v4 as uuidv4 } from 'uuid';
import { toast } from "@/components/ui/use-toast";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { minimaxVoices } from "@/lib/data";
import EmojiComponent from "./EmojiComponent";
import Image from "next/image";

interface SettingsDashboardProps {
  selectedUser: IUser;
  allLanguages: ILanguage[];
}

const categoryOptions: { value: PersonalityFilter; label: string; description: string }[] = [
  { value: "is_story", label: "Story", description: "Storytelling characters" },
  { value: "is_child_voice", label: "Children", description: "Voices for kids" },
];

// Only MiniMax voices are offered: the voice server speaks every character
// through its own voice stack whatever `provider` a row names, so an OpenAI,
// Gemini, Grok or Boson voice id would be handed to MiniMax. Voice prompt,
// emotional tone and pitch are gone for the same reason -- nothing on the
// session path reads them (the device's pitch comes from the server's env).
const formSchema = z.object({
  // Which playground tab the character lives under. The picker shows one tab at
  // a time and requires the flag to be true, so a character without a category
  // would be listed nowhere.
  category: z.enum(["is_story", "is_child_voice"]),
  title: z.string().min(1, "Title is required").max(50, "Maximum 50 characters"),
  description: z.string().max(200, "Maximum 200 characters"),
  prompt: z.string().max(1000, "Maximum 1000 characters"),
  firstMessagePrompt: z.string().max(150, "Maximum 150 characters"),
  voice: z.string().min(1, "Voice selection is required"),
});

type FormData = z.infer<typeof formSchema>;

const collectFormErrors = (zodError: z.ZodError) => {
  const errors: Partial<Record<keyof FormData, string>> = {};
  zodError.errors.forEach((err) => {
    errors[err.path[0] as keyof FormData] = err.message;
  });
  return errors;
};

const SettingsDashboard: React.FC<SettingsDashboardProps> = ({
  selectedUser,
}) => {
  const supabase = createClient();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    category: 'is_story' as PersonalityFilter,
    title: '',
    description: '',
    prompt: '',
    firstMessagePrompt: '',
    voice: '',
  });

  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>({});
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  const handleBlur = (field: keyof FormData) => {
    // Mark the field as touched
    setTouchedFields(prev => ({ ...prev, [field]: true }));

    // Validate the field
    validateField(field, formData[field] as string);
  };

  const validateField = (field: keyof FormData, value: string) => {
    try {
      formSchema.shape[field].parse(value);
      // Clear error if validation passes
      setFormErrors(prev => ({ ...prev, [field]: undefined }));
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        const zodError = error as z.ZodError;
        setFormErrors(prev => ({ ...prev, [field]: zodError.errors[0].message }));
      }
    }
  };

  const handleInputChange = (field: keyof FormData, value: string) => {
    const newFormData = { ...formData, [field]: value };
    setFormData(newFormData);

    // Only validate if the field has been touched before
    if (touchedFields[field]) {
      validateField(field, value);
    }
  };


  const handleImagePicked = (file: File | null) => {
    if (!file) {
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Not an image",
        description: "Pick a PNG, JPEG or WebP file.",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }
    if (file.size > MAX_CHARACTER_IMAGE_BYTES) {
      toast({
        title: "Image too large",
        description: "Please pick an image under 5MB.",
        variant: "destructive",
        duration: 3000,
      });
      return;
    }
    // Revoke the previous preview so replacing the picture repeatedly does not
    // leak object URLs.
    setImagePreview((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return URL.createObjectURL(file);
    });
    setImageFile(file);
  };

  const clearImage = () => {
    setImagePreview((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return null;
    });
    setImageFile(null);
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Set submitting state to true
    setIsSubmitting(true);

    const result = formSchema.safeParse(formData);

    if (!result.success) {
      const errors = collectFormErrors(result.error);
      setFormErrors(errors);
      setTouchedFields((prev) => ({
        ...prev,
        title: true,
        description: true,
        prompt: true,
        firstMessagePrompt: true,
        voice: true,
      }));
      toast({
        title: "Please complete the form",
        description: formData.voice
          ? "Some character details still need to be filled in."
          : "Please pick a voice first.",
        variant: "destructive",
        duration: 3000,
      });
      setIsSubmitting(false);
      return;
    }

    try {
      // Uploaded before the insert on purpose: a failed upload should leave no
      // character behind, whereas an orphaned image costs nothing.
      let imageUrl: string | null = null;
      if (imageFile) {
        imageUrl = await uploadCharacterImage(
          supabase,
          selectedUser.user_id,
          imageFile,
        );
      }

      const personality = await createPersonality(supabase, selectedUser.user_id, {
        provider: "openrouter",
        title: formData.title,
        subtitle: "",
        character_prompt: formData.prompt,
        oai_voice: formData.voice,
        // Written empty rather than left out: the column's default is a
        // sentence the server would add to the prompt.
        voice_prompt: "",
        image_url: imageUrl,
        is_doctor: false,
        is_child_voice: formData.category === "is_child_voice",
        is_story: formData.category === "is_story",
        key: formData.title.toLowerCase().replace(/ /g, '_') + "_" + uuidv4(),
        creator_id: selectedUser.user_id,
        short_description: formData.description,
        pitch_factor: 1,
        first_message_prompt: formData.firstMessagePrompt
      });

      if (personality) {
        toast({
          title: "New AI Character created",
          description: "Your character has been created!",
          duration: 3000,
        });
        router.push(`/home`);
      }
    } catch (error) {
      console.error("Error creating personality:", error);
      toast({
        title: "Error",
        description: "Failed to create your character. Please try again.",
        variant: "destructive",
        duration: 3000,
      });
    } finally {
      setIsSubmitting(false); // Reset submitting state
    }
  };

  const Heading = () => {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex flex-row gap-4 items-center sm:justify-normal justify-between max-w-screen-sm">
          <div className="flex flex-row gap-4 items-center justify-between w-full">
            <h1 className="text-3xl font-normal">Create your AI Character</h1>
          </div>
        </div>
        {/* <HomePageSubtitles user={selectedUser} page="create" /> */}
      </div>
    );
  };

  return (
    <div className="overflow-hidden pb-2 w-full flex-auto flex flex-col pl-1 max-w-screen-sm">
      <Heading />

      <form onSubmit={handleSubmit} className="space-y-6 mt-8 w-full pr-1">
        <div className="space-y-4">
          {/* Voice Picker */}
          <div className="space-y-4">
            <Label htmlFor="voice">Pick a voice</Label>
            <p className="text-sm text-gray-500">
              MiniMax voices. A session in another language uses that language&apos;s default voice.
            </p>
            {formErrors.voice && (
              <p className="text-sm text-red-500">{formErrors.voice}</p>
            )}

            <div className="overflow-x-auto px-2">
              <div className="flex gap-3 w-max py-2">
                {minimaxVoices.map((voice: VoiceType) => (
                  <button
                    type="button"
                    key={voice.id}
                    className={`relative rounded-xl border-2 p-4 transition-all cursor-pointer hover:scale-[1.02] hover:shadow-lg w-48 flex-shrink-0 text-left ${formData.voice === voice.id
                      ? `border-blue-500 shadow-lg ${voice.color} ring-2 ring-blue-200`
                      : `border-gray-200 hover:border-gray-300 ${voice.color} hover:shadow-md`
                      }`}
                    onClick={() => {
                      setFormData(prev => ({ ...prev, voice: voice.id }));
                      setFormErrors(prev => ({ ...prev, voice: undefined }));
                    }}
                  >
                    <div className="flex flex-col">
                      <div className="flex flex-col items-center gap-3">
                        <div className="text-3xl">
                          <EmojiComponent emoji={voice.emoji || "🎙️"} />
                        </div>
                        <div className="flex flex-col text-center">
                          <span className="font-semibold text-gray-900">{voice.name}</span>
                          <span className="text-xs text-gray-600 mt-1">{voice.description}</span>
                        </div>
                      </div>
                      {formData.voice === voice.id && (
                        <div className="absolute -top-2 -right-2">
                          <div className="bg-blue-500 text-white rounded-full p-1.5 shadow-lg">
                            <Check size={12} />
                          </div>
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Character image */}
          <div className="space-y-2">
            <Label htmlFor="characterImage">Character image</Label>
            <p className="text-sm text-gray-500">
              Optional. Without one your character shows up as an emoji.
            </p>
            <div className="flex flex-row items-center gap-4">
              <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-full border border-gray-200 bg-gray-50">
                {imagePreview ? (
                  <Image
                    src={imagePreview}
                    alt="Character preview"
                    fill
                    unoptimized
                    className="object-cover object-top"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-gray-400">
                    <ImagePlus className="h-7 w-7" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="characterImage"
                  className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium shadow-sm hover:bg-gray-50"
                >
                  <ImagePlus className="h-4 w-4" />
                  {imageFile ? "Change image" : "Upload image"}
                </label>
                <input
                  id="characterImage"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    handleImagePicked(e.target.files?.[0] ?? null);
                    // Let the same file be picked again after clearing it.
                    e.target.value = "";
                  }}
                />
                {imageFile && (
                  <button
                    type="button"
                    onClick={clearImage}
                    className="inline-flex w-fit items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
                  >
                    <X className="h-3 w-3" /> Remove
                  </button>
                )}
                <span className="text-xs text-gray-400">PNG, JPEG or WebP, up to 5MB</span>
              </div>
            </div>
          </div>

          {/* Category */}
          <div className="space-y-2">
            <Label>Category</Label>
            <p className="text-sm text-gray-500">
              Which playground tab your character is listed under.
            </p>
            <div className="grid grid-cols-3 gap-3">
              {categoryOptions.map((category) => (
                <button
                  key={category.value}
                  type="button"
                  onClick={() =>
                    setFormData((prev) => ({ ...prev, category: category.value }))
                  }
                  className={`rounded-lg border p-3 text-center transition-all ${formData.category === category.value
                    ? "border-2 border-blue-500 bg-blue-50 shadow-sm"
                    : "border-gray-200 hover:border-gray-300"
                    }`}
                >
                  <span className="block text-sm font-medium">{category.label}</span>
                  <span className="block text-xs text-gray-500">{category.description}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              placeholder="AI Hulk"
              value={formData.title}
              onChange={(e) => handleInputChange('title', e.target.value)}
              onBlur={() => handleBlur('title')}
            />
            <p className="text-sm flex justify-between">
              <span className={formErrors.title ? "text-red-500" : "text-gray-500"}>
                {formErrors.title}
              </span>
              <span className="text-gray-500">{formData.title.length}/50</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              placeholder="Describe what your AI character does and its personality..."
              rows={2}
              value={formData.description}
              onChange={(e) => handleInputChange('description', e.target.value)}
              onBlur={() => handleBlur('description')} />
            <p className="text-sm flex justify-between">
              <span className={formErrors.description ? "text-red-500" : "text-gray-500"}>
                {formErrors.description}
              </span>
              <span className="text-gray-500">{formData.description.length}/200</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="prompt">Prompt</Label>
            <Textarea
              id="prompt"
              placeholder="Enter specific instructions for how your AI should respond..."
              rows={4}
              value={formData.prompt}
              onChange={(e) => handleInputChange('prompt', e.target.value)}
              onBlur={() => handleBlur('prompt')}
            />
            <p className="text-sm flex justify-between">
              <span className={formErrors.prompt ? "text-red-500" : "text-gray-500"}>
                {formErrors.prompt}
              </span>
              <span className="text-gray-500">{formData.prompt.length}/1000</span>
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="firstMessagePrompt">First message prompt</Label>
            <Textarea
              id="firstMessagePrompt"
              placeholder="How your AI character should respond in the first message to the user..."
              rows={4}
              value={formData.firstMessagePrompt}
              onChange={(e) => handleInputChange('firstMessagePrompt', e.target.value)}
              onBlur={() => handleBlur('firstMessagePrompt')}
            />
            <p className="text-sm flex justify-between">
              <span className={formErrors.firstMessagePrompt ? "text-red-500" : "text-gray-500"}>
                {formErrors.firstMessagePrompt}
              </span>
              <span className="text-gray-500">{formData.firstMessagePrompt.length}/150</span>
            </p>
          </div>
        </div>

        <div className="w-full flex justify-end">
          <Button
            variant="default"
            className="flex flex-row gap-2 items-center"
            type="submit"
            disabled={
              isSubmitting ||
              formData.title === '' ||
              formData.description === '' ||
              formData.prompt === '' ||
              formData.voice === ''
            }
          >
            {isSubmitting ? "Creating..." : "Create"} {!isSubmitting && <Check className="w-4 h-4" />}
          </Button>
        </div>
      </form>
    </div>
  )
};

export default SettingsDashboard;