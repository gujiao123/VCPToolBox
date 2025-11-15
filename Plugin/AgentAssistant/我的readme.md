1.修改config.env 根据要求进行填充
2.一定要修改plugin-manifest.json 不然不会生效
3.开启Debugmode记得加String啊啊啊不然会报错 而且竟然连启动没有成功的错误都不报错槽尼玛  DEBUG_MODE = String(config.DebugMode || "False").toLowerCase() === "true";


人家的edit.example就是告诉你应该如何修改 啊啊啊啊该死啊我啊啊啊啊

注意名字AGENT_SCARLETFLAME_MODEL_ID