#!/usr/bin/env python3
"""
MCPO 插件配置诊断脚本 (VCP 博士版 v2.0)

前提：假设 mcpo_plugin.py 代码 100% 正确。
目的：诊断导致启动失败的环境配置错误。
"""

import sys
import os
import json
import time
import shutil  # 用于检查 PATH
import traceback


# --- 打印助手 ---
def print_ok(message):
    print(f"✅ [通过] {message}")


def print_fail(message, exit_script=False):
    print(f"❌ [失败] {message}")
    if exit_script:
        print("\n诊断终止。请修复上述配置错误后重试。")
        sys.exit(1)


def print_warn(message):
    print(f"⚠️ [警告] {message}")


def print_info(message):
    print(f"ℹ️ [信息] {message}")


# --- 检查 1: 导入和初始化 ---
print_info("--- 测试 1: 导入插件和加载配置 ---")
try:
    from mcpo_plugin import MCPOPlugin

    print_ok("成功导入 MCPOPlugin 模块。")
except ImportError as e:
    print_fail(f"无法导入 MCPOPlugin 模块: {e}", exit_script=True)
except Exception as e:
    print_fail(
        f"导入 MCPOPlugin 时发生未知错误: {e}\n{traceback.format_exc()}",
        exit_script=True,
    )

try:
    plugin = MCPOPlugin()
    config = plugin.config
    print_ok("插件实例初始化成功。")
    print_info(f"  > MCPO 端口: {config.get('MCPO_PORT')}")
    print_info(f"  > 配置文件路径: {config.get('MCP_CONFIG_PATH')}")
    print_info(f"  > Python 可执行文件: {config.get('PYTHON_EXECUTABLE')}")
except Exception as e:
    print_fail(
        f"无法初始化 MCPOPlugin 实例: {e}\n{traceback.format_exc()}", exit_script=True
    )


# --- 检查 2: MCP_CONFIG_PATH 是否有效 ---
print_info("\n--- 测试 2: 检查 'MCP_CONFIG_PATH' ---")
config_path = config.get("MCP_CONFIG_PATH")
if os.path.exists(config_path):
    print_ok(f"配置文件存在于: {config_path}")
else:
    print_fail(f"配置文件不存在: {config_path}", exit_script=True)

# --- 检查 3: mcp-config.json 语法 ---
print_info("\n--- 测试 3: 检查 'mcp-config.json' 语法 ---")
try:
    with open(config_path, "r", encoding="utf-8") as f:
        mcp_config = json.load(f)
    print_ok(f"配置文件 {os.path.basename(config_path)} 是有效的 JSON。")
except json.JSONDecodeError as e:
    print_fail(
        f"配置文件 {os.path.basename(config_path)} 语法错误: {e}", exit_script=True
    )
except Exception as e:
    print_fail(
        f"读取配置文件 {os.path.basename(config_path)} 时出错: {e}", exit_script=True
    )

# --- 检查 4: mcp-config.json 内部依赖 ---
print_info("\n--- 测试 4: 检查 'mcp-config.json' 内部命令 ---")
all_deps_found = True
if "mcpServers" in mcp_config:
    for server_name, server_config in mcp_config["mcpServers"].items():
        cmd_to_check = server_config.get("command")
        if not cmd_to_check:
            print_warn(f"服务器 '{server_name}' 没有定义 'command'。")
            continue

        if shutil.which(cmd_to_check):
            print_ok(
                f"  > 依赖 '{cmd_to_check}' (用于 {server_name}) 在 PATH 中已找到。"
            )
        else:
            print_fail(
                f"  > 依赖 '{cmd_to_check}' (用于 {server_name}) 在 PATH 中未找到。"
            )
            all_deps_found = False
else:
    print_warn("mcpServers 部分为空或不存在。")
if not all_deps_found:
    print_warn("一个或多个内部命令未找到，MCPO 服务器可能会启动失败。")

# --- 检查 5: PYTHON_EXECUTABLE ---
print_info("\n--- 测试 5: 检查 'PYTHON_EXECUTABLE' 配置 ---")
py_exec = config.get("PYTHON_EXECUTABLE")
if shutil.which(py_exec):
    print_ok(f"Python 可执行文件 '{py_exec}' 在 PATH 中已找到。")
else:
    print_fail(
        f"配置的 'PYTHON_EXECUTABLE' ('{py_exec}') 在 PATH 中未找到。", exit_script=True
    )

# --- 检查 6: 'mcpo' 命令（核心问题） ---
print_info("\n--- 测试 6: 检查 'mcpo' 命令的可执行路径 ---")
mcpo_cmd = "mcpo"
mcpo_path_in_env = shutil.which(mcpo_cmd)

if mcpo_path_in_env:
    print_ok(f"'mcpo' 命令在 PATH 中已找到: {mcpo_path_in_env}")
else:
    print_fail("'mcpo' 命令未在系统 PATH 环境变量中找到。")
    print_info("mcpo_plugin.py 依赖此命令才能启动。")

    # 诊断已知位置
    known_path = "/usr/src/app/pydeps/bin/mcpo"
    print_info(f"正在检查 'mcpo' 是否安装在已知路径: {known_path}...")

    if os.path.exists(known_path):
        print_warn(f"诊断成功：'mcpo' 位于 {known_path}，但该目录不在 PATH 中。")
        print_warn(
            "这是 [Errno 2] No such file or directory No such file or directory: 'mcpo'] 错误的根本原因。"
        )
        print_info(
            "解决方案：重新构建 Docker 容器，确保 /usr/src/app/pydeps/bin 被添加到 PATH 环境变量中。"
        )
    else:
        print_fail(f"在 {known_path} 也未找到 'mcpo'。")
        print_fail(
            "解决方案：请在容器内运行 'pip install mcpo --break-system-packages'。"
        )

    print_fail("测试 6 失败，启动将无法进行。", exit_script=True)


# --- 检查 7: 实际启动测试 ---
print_info("\n--- 测试 7: 尝试实际启动、检查和停止 ---")
print_info("所有配置检查均通过。现在将尝试运行插件的内置管理功能...")


def run_live_step(step_name, func):
    """辅助函数：运行一个实时的插件步骤"""
    print(f"--- [ {step_name} ] ---")
    try:
        result = func()
        print(f"    [原始返回]: {json.dumps(result, indent=2, ensure_ascii=False)}")

        if result.get("success", False) or result.get("status") == "success":
            print_ok(f"{step_name} 成功。")
            return True
        else:
            print_fail(f"{step_name} 失败。")
            return False
    except Exception as e:
        print_fail(f"{step_name} 执行时发生 Python 异常: {e}\n{traceback.format_exc()}")
        return False


# 1. 清理
if not run_live_step("清理环境 (停止)", lambda: plugin.manage_server("stop")):
    print_warn("初始停止操作失败（这通常是正常的）。")

time.sleep(2)  # 等待端口释放

# 2. 启动
if not run_live_step("启动服务器 (Start)", lambda: plugin.manage_server("start")):
    print_fail(
        "无法启动 MCPO 服务器。这是在所有配置检查通过后发生的。", exit_script=True
    )

# 3. 检查
if not run_live_step("健康检查 (Health Check)", lambda: plugin.health_check()):
    print_fail("服务器已启动，但健康检查失败。", exit_script=True)

# 4. 列出工具
if not run_live_step("列出工具 (List Tools)", lambda: plugin.list_tools()):
    print_fail("服务器健康，但无法列出工具。", exit_script=True)

# 5. 停止
if not run_live_step("停止服务器 (Stop)", lambda: plugin.manage_server("stop")):
    print_fail("测试已完成，但停止服务器失败。", exit_script=True)

# --- 成功 ---
print("\n" + "🎉 所有测试通过！" * 3 + "")
print("MCPO 插件配置正确，服务器可以成功启动、通信和关闭。")
