import type { ITheme } from "@xterm/xterm";

/**
 * 终端配色：每套都有深浅两版。
 * 默认「跟随界面」——app 是浅色，终端就用浅版；切深色一起变。
 */
export interface TermScheme {
  id: string;
  label: string;
  dark: ITheme;
  light: ITheme;
}

export type TermVariant = "auto" | "dark" | "light";

export const TERM_SCHEMES: TermScheme[] = [
  {
    id: "az",
    label: "Az",
    dark: {
      background: "#14161c", foreground: "#e6e8ef", cursor: "#6a8cff", cursorAccent: "#14161c",
      selectionBackground: "#2b3358", selectionForeground: "#ffffff",
      black: "#2a2f3a", red: "#ff6b7a", green: "#3ddc84", yellow: "#ffc53d",
      blue: "#6a8cff", magenta: "#b07cff", cyan: "#4dd4e0", white: "#d7dae5",
      brightBlack: "#5b6172", brightRed: "#ff8f9b", brightGreen: "#6ae8a2", brightYellow: "#ffd76a",
      brightBlue: "#8fa8ff", brightMagenta: "#c79bff", brightCyan: "#7de6ef", brightWhite: "#f4f6fb",
    },
    light: {
      background: "#fbfbfd", foreground: "#1f2330", cursor: "#1e40d8", cursorAccent: "#ffffff",
      selectionBackground: "#d9e0ff", selectionForeground: "#10131c",
      black: "#1f2330", red: "#d6455a", green: "#12894f", yellow: "#a86f12",
      blue: "#1e40d8", magenta: "#7a4dd6", cyan: "#0e8f9e", white: "#8a8fa3",
      brightBlack: "#6b7183", brightRed: "#e05a6d", brightGreen: "#1aa561",
      brightYellow: "#c2871f", brightBlue: "#3a5ae8", brightMagenta: "#9166e6", brightCyan: "#12a7b8", brightWhite: "#2b3040",
    },
  },
  {
    id: "catppuccin",
    label: "Catppuccin",
    dark: {
      background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e",
      selectionBackground: "#45475a", selectionForeground: "#cdd6f4",
      black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
      blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
      brightBlack: "#585b70", brightRed: "#f5a3bb", brightGreen: "#bbe9b6", brightYellow: "#fbeac6",
      brightBlue: "#a3c5fb", brightMagenta: "#f8d3ee", brightCyan: "#abe9df", brightWhite: "#a6adc8",
    },
    light: {
      background: "#eff1f5", foreground: "#4c4f69", cursor: "#dc8a78", cursorAccent: "#eff1f5",
      selectionBackground: "#ccd0da", selectionForeground: "#4c4f69",
      black: "#5c5f77", red: "#d20f39", green: "#40a02b", yellow: "#df8e1d",
      blue: "#1e66f5", magenta: "#ea76cb", cyan: "#179299", white: "#acb0be",
      brightBlack: "#6c6f85", brightRed: "#e64553", brightGreen: "#4fb138", brightYellow: "#e79f2c",
      brightBlue: "#3b7bf6", brightMagenta: "#ef8bd6", brightCyan: "#1ba7ac", brightWhite: "#8c8fa1",
    },
  },
  {
    id: "tokyo",
    label: "Tokyo Night",
    dark: {
      background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "#33467c", selectionForeground: "#c0caf5",
      black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
      blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
      brightBlack: "#414868", brightRed: "#ff9aad", brightGreen: "#b3e08a", brightYellow: "#edc98a",
      brightBlue: "#9bb8f9", brightMagenta: "#cdb4f9", brightCyan: "#a0dcff", brightWhite: "#c0caf5",
    },
    light: {
      background: "#e6e7ed", foreground: "#343b58", cursor: "#2e7de9", cursorAccent: "#e6e7ed",
      selectionBackground: "#b6bfe2", selectionForeground: "#343b58",
      black: "#343b58", red: "#f52a65", green: "#587539", yellow: "#8c6c3e",
      blue: "#2e7de9", magenta: "#9854f1", cyan: "#007197", white: "#6172b0",
      brightBlack: "#606a97", brightRed: "#f7527b", brightGreen: "#6a8b47", brightYellow: "#a3814c",
      brightBlue: "#4a90ec", brightMagenta: "#a870f3", brightCyan: "#1287ab", brightWhite: "#3760bf",
    },
  },
  {
    id: "nord",
    label: "Nord",
    dark: {
      background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0", cursorAccent: "#2e3440",
      selectionBackground: "#434c5e", selectionForeground: "#eceff4",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
      blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
      brightBlack: "#4c566a", brightRed: "#cf7982", brightGreen: "#b6cda3", brightYellow: "#f0d7a3",
      brightBlue: "#96b4cf", brightMagenta: "#c4a3bd", brightCyan: "#9fd0dd", brightWhite: "#eceff4",
    },
    light: {
      background: "#eceff4", foreground: "#2e3440", cursor: "#5e81ac", cursorAccent: "#eceff4",
      selectionBackground: "#d8dee9", selectionForeground: "#2e3440",
      black: "#2e3440", red: "#a5454e", green: "#6a8352", yellow: "#9a7524",
      blue: "#5e81ac", magenta: "#8c6a86", cyan: "#3f8496", white: "#8b93a3",
      brightBlack: "#5b6376", brightRed: "#bf616a", brightGreen: "#7d9663", brightYellow: "#b08a2f",
      brightBlue: "#7295bd", brightMagenta: "#a37f9c", brightCyan: "#4f9bad", brightWhite: "#3b4252",
    },
  },
  {
    id: "github",
    label: "GitHub",
    dark: {
      background: "#0d1117", foreground: "#c9d1d9", cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "#163356", selectionForeground: "#c9d1d9",
      black: "#484f58", red: "#ff7b72", green: "#3fb950", yellow: "#d29922",
      blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5cf", white: "#b1bac4",
      brightBlack: "#6e7681", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#e3b341",
      brightBlue: "#79c0ff", brightMagenta: "#d2a8ff", brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
    },
    light: {
      background: "#ffffff", foreground: "#24292f", cursor: "#0969da", cursorAccent: "#ffffff",
      selectionBackground: "#b6e3ff", selectionForeground: "#24292f",
      black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
      blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
      brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#9a6700",
      brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
    },
  },
  {
    id: "one",
    label: "One",
    dark: {
      background: "#282c34", foreground: "#abb2bf", cursor: "#61afef", cursorAccent: "#282c34",
      selectionBackground: "#3e4451", selectionForeground: "#dcdfe4",
      black: "#3f4451", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
      blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
      brightBlack: "#5c6370", brightRed: "#ec8a92", brightGreen: "#aed095", brightYellow: "#edcd9a",
      brightBlue: "#82c0f2", brightMagenta: "#d59ce6", brightCyan: "#77c6d0", brightWhite: "#dcdfe4",
    },
    light: {
      background: "#fafafa", foreground: "#383a42", cursor: "#4078f2", cursorAccent: "#fafafa",
      selectionBackground: "#d0d4da", selectionForeground: "#383a42",
      black: "#383a42", red: "#e45649", green: "#3f8a3e", yellow: "#a06600",
      blue: "#4078f2", magenta: "#a626a4", cyan: "#0184bc", white: "#8b8f99",
      brightBlack: "#616570", brightRed: "#e8695c", brightGreen: "#4f9c4d", brightYellow: "#b57a12",
      brightBlue: "#5a8cf4", brightMagenta: "#b53fb3", brightCyan: "#1897cf", brightWhite: "#4a4d57",
    },
  },
];

export const FONT_SIZES = [12, 13, 14, 16];

export const schemeOf = (id: string): TermScheme => TERM_SCHEMES.find((one) => one.id === id) ?? TERM_SCHEMES[0];

/** 取实际要用的那份色板：variant 已经是 dark / light 具体值 */
export const themeOf = (id: string, variant: "dark" | "light"): ITheme => schemeOf(id)[variant];
