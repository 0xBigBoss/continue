---
title: 上下文选择
description: 自动补全上下文选择
keywords: [上下文, 自动补全, lsp, 最近的]
sidebar_position: 3
---

自动补全会基于当前的光标位置自动地确定上下文。我们使用以下的技术来确定什么包含在提示词中：

### 文件前缀/后缀

我们总是包含你的文件中光标前后的代码。

### 来自语言服务协议的定义

类似于你如何在编辑器中使用 `cmd/ctrl + click` ，我们使用相同的工具 (LSP) 来增强 "转到定义" 。例如，如果你输入一个函数调用，我们将包含函数定义。或者，如果你在一个方法中写代码，我们将包含类型定义中的任何参数或返回类型。

### 导入文件

因为通常有很多导入，我们不能包含它们所有。相反，我们查找你的光标附近的标识，使用它所匹配的导入作为上下文。

### 最近的文件

我们自动考虑最近打开的或编辑的文件，并包含与当前补全相关的片段。