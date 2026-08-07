import type { JSX } from "solid-js"

export function Link(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      {...props}
      target={props.target ?? "_blank"}
      rel={props.rel ?? "noopener noreferrer"}
    >
      {props.children}
    </a>
  )
}
