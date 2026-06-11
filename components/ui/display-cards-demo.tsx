"use client";

import { Sparkles } from "lucide-react";

import DisplayCards from "@/components/ui/display-cards";

const defaultCards = [
  {
    icon: <Sparkles className="size-4 text-blue-300" />,
    title: "Presence",
    description: "F.E.A.R. is listening",
    date: "Live",
    iconClassName: "text-blue-500",
    titleClassName: "text-blue-400",
    className:
      "[grid-area:stack] hover:-translate-y-10 before:absolute before:left-0 before:top-0 before:h-[100%] before:w-[100%] before:rounded-xl before:bg-background/50 before:bg-blend-overlay before:outline before:outline-1 before:outline-border before:content-[''] before:transition-opacity before:duration-700 hover:before:opacity-0 grayscale-[100%] hover:grayscale-0",
  },
  {
    icon: <Sparkles className="size-4 text-blue-300" />,
    title: "Memory",
    description: "Personal facts indexed",
    date: "ChromaDB",
    iconClassName: "text-blue-500",
    titleClassName: "text-violet-300",
    className:
      "[grid-area:stack] translate-x-12 translate-y-10 hover:-translate-y-1 before:absolute before:left-0 before:top-0 before:h-[100%] before:w-[100%] before:rounded-xl before:bg-background/50 before:bg-blend-overlay before:outline before:outline-1 before:outline-border before:content-[''] before:transition-opacity before:duration-700 hover:before:opacity-0 grayscale-[100%] hover:grayscale-0",
  },
  {
    icon: <Sparkles className="size-4 text-blue-300" />,
    title: "Actions",
    description: "Voice, Spotify, gestures",
    date: "Desktop",
    iconClassName: "text-blue-500",
    titleClassName: "text-cyan-200",
    className: "[grid-area:stack] translate-x-24 translate-y-20 hover:translate-y-10",
  },
];

export function DisplayCardsDemo() {
  return (
    <div className="flex min-h-[400px] w-full items-center justify-center py-20">
      <div className="w-full max-w-3xl">
        <DisplayCards cards={defaultCards} />
      </div>
    </div>
  );
}
