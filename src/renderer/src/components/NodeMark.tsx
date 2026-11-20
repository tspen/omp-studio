import React from "react";
import type { TreeNode } from "../../../shared/types";
import { cx } from "./Common";

const PROJECT_COLORS = [
  "#C0523F",
  "#A86218",
  "#8C6D10",
  "#5F7F1C",
  "#237A50",
  "#12756F",
  "#146C8E",
  "#2E62B8",
  "#4E46B8",
  "#6E42B0",
  "#8E3AA0",
  "#A83A70",
  "#A63D4B",
  "#6255B0",
  "#2F6E62",
  "#7E542F",
];

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function hex(value: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return [90, 80, 160];
  const number = Number.parseInt(match[1], 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function shade(value: string, amount: number): string {
  const [red, green, blue] = hex(value);
  const shift = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel + (amount > 0 ? (255 - channel) : channel) * (amount / 100))));
  return `rgb(${shift(red)} ${shift(green)} ${shift(blue)})`;
}

export function nodeAccent(node: Pick<TreeNode, "id" | "color">): string {
  if (node.color && /^#[0-9a-f]{6}$/i.test(node.color)) return node.color;
  return PROJECT_COLORS[hash(node.id) % PROJECT_COLORS.length];
}

function initials(name: string): string {
  const words = name.trim().split(/[\s\-_./]+/).filter(Boolean);
  if (words.length >= 2) return `${Array.from(words[0])[0] ?? ""}${Array.from(words[1])[0] ?? ""}`.toUpperCase();
  const letters = Array.from(name.trim()).filter((character) => /[\p{L}\p{N}]/u.test(character));
  return (letters.slice(0, 2).join("") || "•").toUpperCase();
}

export function NodeMark({
  node,
  size = 20,
  className,
}: {
  node: Pick<TreeNode, "id" | "name" | "color">;
  size?: number;
  className?: string;
}) {
  const accent = nodeAccent(node);
  const pattern = hash(node.id) % 4;
  const label = initials(node.name);
  return (
    <span
      className={cx("node-mark", className)}
      style={{
        width: size,
        height: size,
        borderRadius: Math.max(5, Math.round(size * 0.3)),
        background: `linear-gradient(145deg, ${shade(accent, 16)}, ${shade(accent, -18)})`,
        fontSize: Math.max(8, Math.round(size * 0.42)),
      }}
      title={node.name}
      aria-hidden
    >
      <svg className="node-mark-pattern" viewBox="0 0 40 40" fill="none">
        {pattern === 0 ? (
          <>
            <circle cx="20" cy="20" r="18" stroke="white" strokeOpacity="0.14" strokeWidth="2" />
            <circle cx="20" cy="20" r="11" stroke="white" strokeOpacity="0.1" strokeWidth="2" />
          </>
        ) : pattern === 1 ? (
          <path d="M-10 34L34 -10" stroke="white" strokeOpacity="0.13" strokeWidth="10" />
        ) : pattern === 2 ? (
          <>
            <circle cx="10" cy="10" r="10" fill="white" fillOpacity="0.1" />
            <circle cx="32" cy="30" r="7" fill="white" fillOpacity="0.08" />
          </>
        ) : (
          <path d="M40 -2C20 -2 2 18 2 42" stroke="white" strokeOpacity="0.14" strokeWidth="3" />
        )}
      </svg>
      <span>{label}</span>
    </span>
  );
}
