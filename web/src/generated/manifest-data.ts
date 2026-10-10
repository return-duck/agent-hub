/* eslint-disable */
/**
 * 自动生成，请勿手工修改。
 * 由 scripts/codegen.mjs 从 contracts/node-manifest.json 生成。
 * 重新生成：npm run codegen
 */

export const nodeManifest = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-stack.local/contracts/node-manifest.json",
  "title": "NodeManifest",
  "description": "节点能力清单：runtime 据此装配执行器，web 据此渲染配置表单。新增节点类型只需改这里 + 加一个执行器。",
  "version": 1,
  "toolNames": [
    "calculator",
    "http_get"
  ],
  "nodeTypes": [
    {
      "type": "start",
      "displayName": "开始",
      "category": "input",
      "description": "运行入口，声明本次运行的输入变量",
      "maxIncoming": 0,
      "maxOutgoing": 1,
      "configSchema": {
        "type": "object",
        "properties": {
          "inputVariables": {
            "type": "array",
            "default": [],
            "items": {
              "type": "object",
              "required": [
                "name",
                "type"
              ],
              "properties": {
                "name": {
                  "type": "string",
                  "minLength": 1
                },
                "type": {
                  "enum": [
                    "string",
                    "number",
                    "boolean"
                  ]
                },
                "required": {
                  "type": "boolean",
                  "default": true
                },
                "description": {
                  "type": "string"
                }
              }
            }
          }
        }
      },
      "uiSchema": {
        "inputVariables": {
          "widget": "variableList"
        }
      }
    },
    {
      "type": "prompt",
      "displayName": "提示词",
      "category": "prompt",
      "description": "把模板渲染成一条消息，支持 {{input.x}} 与 {{scratchpad.y}}",
      "maxIncoming": 1,
      "maxOutgoing": 1,
      "outputs": [
        {
          "name": "text",
          "type": "string",
          "label": "提示词"
        }
      ],
      "configSchema": {
        "type": "object",
        "required": [
          "template"
        ],
        "properties": {
          "role": {
            "enum": [
              "system",
              "human"
            ],
            "default": "human"
          },
          "template": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": {
              "mode": "custom",
              "value": "",
              "ref": ""
            }
          },
          "outputKey": {
            "type": "string",
            "default": "prompt"
          }
        }
      },
      "uiSchema": {
        "template": {
          "widget": "binding",
          "valueType": "string",
          "multiline": true,
          "label": "提示词",
          "placeholder": "请介绍 {{input.topic}}"
        },
        "role": {
          "widget": "select"
        }
      }
    },
    {
      "type": "llm",
      "displayName": "大模型",
      "category": "model",
      "description": "调用模型；配置了工具时会编译成 model → ToolNode → toolsCondition 的 ReAct 循环",
      "maxIncoming": 1,
      "maxOutgoing": 1,
      "outputs": [
        {
          "name": "text",
          "type": "string",
          "label": "模型输出"
        }
      ],
      "configSchema": {
        "type": "object",
        "properties": {
          "system": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": ""
          },
          "temperature": {
            "type": "number",
            "minimum": 0,
            "maximum": 2,
            "default": 0.2
          },
          "tools": {
            "type": "array",
            "default": [],
            "items": {
              "enum": [
                "calculator",
                "http_get"
              ]
            }
          },
          "maxSteps": {
            "type": "integer",
            "minimum": 1,
            "maximum": 20,
            "default": 6
          },
          "outputKey": {
            "type": "string",
            "default": "answer"
          }
        }
      },
      "uiSchema": {
        "system": {
          "widget": "binding",
          "valueType": "string",
          "multiline": true,
          "label": "系统提示",
          "placeholder": "你是……"
        },
        "tools": {
          "widget": "multiselect"
        },
        "temperature": {
          "widget": "number"
        },
        "maxSteps": {
          "widget": "number"
        }
      }
    },
    {
      "type": "http",
      "displayName": "HTTP 调用",
      "category": "http",
      "description": "发起一次 HTTP 请求。URL、请求头、请求体可以选择上游输出（类型须一致），也可以自己填写。结果的状态码、响应体、JSON 可被后续节点选为输入。",
      "maxIncoming": 1,
      "maxOutgoing": 1,
      "outputs": [
        {
          "name": "status",
          "type": "number",
          "label": "状态码"
        },
        {
          "name": "ok",
          "type": "boolean",
          "label": "是否成功"
        },
        {
          "name": "body",
          "type": "string",
          "label": "响应体"
        },
        {
          "name": "json",
          "type": "object",
          "label": "JSON"
        },
        {
          "name": "result",
          "type": "object",
          "label": "完整响应"
        }
      ],
      "configSchema": {
        "type": "object",
        "required": [
          "url"
        ],
        "properties": {
          "method": {
            "enum": [
              "GET",
              "POST",
              "PUT",
              "PATCH",
              "DELETE"
            ],
            "default": "GET"
          },
          "url": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": {
              "mode": "custom",
              "value": "",
              "ref": ""
            }
          },
          "headers": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": ""
          },
          "body": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": ""
          },
          "outputKey": {
            "type": "string",
            "default": "http"
          },
          "timeoutMs": {
            "type": "integer",
            "minimum": 100,
            "maximum": 60000,
            "default": 10000
          }
        }
      },
      "uiSchema": {
        "method": {
          "widget": "select"
        },
        "url": {
          "widget": "binding",
          "valueType": "string",
          "label": "URL",
          "placeholder": "https://example.com/search?q={{input.query}}"
        },
        "headers": {
          "widget": "binding",
          "valueType": "string",
          "multiline": true,
          "label": "请求头",
          "placeholder": "{\"accept\":\"application/json\"}"
        },
        "body": {
          "widget": "binding",
          "valueType": "string",
          "multiline": true,
          "label": "请求体",
          "placeholder": "{\"q\":\"{{input.query}}\"}"
        },
        "timeoutMs": {
          "widget": "number"
        }
      }
    },
    {
      "type": "code",
      "displayName": "代码执行",
      "category": "code",
      "description": "执行一段 JavaScript（仅 JS）。每个输入可以选择类型一致的上游输出，或不选而自己填写。return 的值按输出类型提供给后续节点。",
      "maxIncoming": 1,
      "maxOutgoing": 1,
      "outputs": [
        {
          "name": "result",
          "type": "object",
          "label": "返回值"
        }
      ],
      "configSchema": {
        "type": "object",
        "required": [
          "source"
        ],
        "properties": {
          "source": {
            "anyOf": [
              {
                "type": "string",
                "minLength": 1
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": {
              "mode": "custom",
              "value": "",
              "ref": ""
            }
          },
          "inputs": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "name",
                    "type"
                  ],
                  "properties": {
                    "name": {
                      "type": "string"
                    },
                    "type": {
                      "enum": [
                        "string",
                        "number",
                        "boolean",
                        "object"
                      ]
                    },
                    "mode": {
                      "enum": [
                        "custom",
                        "ref"
                      ],
                      "default": "custom"
                    },
                    "value": {},
                    "ref": {
                      "type": "string",
                      "default": ""
                    }
                  }
                }
              }
            ],
            "default": []
          },
          "outputType": {
            "enum": [
              "string",
              "number",
              "boolean",
              "object"
            ],
            "default": "object"
          },
          "outputKey": {
            "type": "string",
            "default": "code"
          },
          "timeoutMs": {
            "type": "integer",
            "minimum": 50,
            "maximum": 5000,
            "default": 1000
          }
        }
      },
      "uiSchema": {
        "source": {
          "widget": "binding",
          "valueType": "string",
          "multiline": true,
          "label": "代码",
          "placeholder": "return { status: inputs.status, query: inputs.query };"
        },
        "inputs": {
          "widget": "bindingList",
          "label": "输入"
        },
        "outputType": {
          "widget": "select",
          "label": "输出类型"
        },
        "timeoutMs": {
          "widget": "number"
        }
      }
    },
    {
      "type": "end",
      "displayName": "结束",
      "category": "output",
      "description": "汇总输出。可以选择任意上游输出作为本次结果；不选则填写自定义文本，或沿用最后一条模型输出。",
      "maxIncoming": 1,
      "maxOutgoing": 0,
      "configSchema": {
        "type": "object",
        "properties": {
          "value": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "object",
                "required": [
                  "mode"
                ],
                "properties": {
                  "mode": {
                    "enum": [
                      "custom",
                      "ref"
                    ]
                  },
                  "value": {},
                  "ref": {
                    "type": "string",
                    "default": ""
                  }
                }
              }
            ],
            "default": ""
          },
          "outputKey": {
            "type": "string",
            "default": "answer"
          }
        }
      },
      "uiSchema": {
        "value": {
          "widget": "binding",
          "valueType": "any",
          "label": "输出",
          "placeholder": "留空则使用模型输出"
        }
      }
    }
  ]
} as const;
