declare module "*.css";

import type { JSX as ReactJSX } from "react";

type SButtonProps = ReactJSX.IntrinsicElements["s-button"];

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-button": SButtonProps & {
        inlineSize?: "auto" | "fill" | "fit-content";
      };
    }
  }
}
