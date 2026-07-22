export const FONT_MAP = {
  inter: {
    regular: "public/fonts/Inter-Variable.ttf",
    bold: "public/fonts/Inter-Bold.ttf"
  },
  instrumentSerif: {
    regular: "public/fonts/InstrumentSerif-Regular.ttf",
    bold: "public/fonts/InstrumentSerif-Regular.ttf"
  },
  jetbrainsMono: {
    regular: "public/fonts/JetBrainsMono-Regular.ttf",
    bold: "public/fonts/JetBrainsMono-Bold.ttf"
  }
};

export const SIZE_MAP = {
  small: "h*0.045",
  medium: "h*0.07",
  large: "h*0.1"
};

export const POSITION_MAP = {
  top: "x=(w-text_w)/2:y=h*0.1",
  center: "x=(w-text_w)/2:y=(h-text_h)/2",
  bottom: "x=(w-text_w)/2:y=h*0.82"
};

export const COLOR_MAP = {
  white: "0xFFFFFF",
  black: "0x000000",
  yellow: "0xF6D365",
  red: "0xE94B4B",
  blue: "0x4A90E2",
  green: "0x4CAF50",
  orange: "0xF28C28",
  purple: "0x8E6CEF",
  pink: "0xEC6AA8"
};

export const TITLE_DEFAULTS = {
  position: "center",
  size: "medium",
  color: "white",
  weight: "regular",
  font: "inter"
};
