"use client";

import { memo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown from "react-markdown";
import remend from "remend";
import { markdownBlocks } from "../lib/markdown-blocks";
import { remarkPlugins } from "../lib/markdown-plugins";

const components = {
  a: (props: ComponentPropsWithoutRef<"a">) => (
    <a {...props} target="_blank" rel="noreferrer noopener" />
  ),
};

/** 一块一个解析器实例，内容没变就不重新解析——流式输出时只有最后一块在变。 */
const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * streaming：回答还在往外出字。最后一块先用 remend 把没写完的 `**`、`` ` ``、链接补齐，
 * 不然半截的加粗先露出星号、等配对的那个到了又突然变粗，一闪一闪。
 */
export function AiMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const blocks = markdownBlocks(content);
  return blocks.map((block, index) => (
    <Block
      key={index}
      text={streaming && index === blocks.length - 1 ? remend(block, { linkMode: "text-only" }) : block}
    />
  ));
}
