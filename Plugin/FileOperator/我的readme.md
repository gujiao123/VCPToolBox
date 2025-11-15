

先设置 别说话


我真的是草死你的马啊 
要把 .env改为config.env


还有一件事对于docker还需要路径映射

别乱映射 反正都用设使用相对路径就可以了


请注释这两个代码 因为根本都没有用到
#CREATE_BACKUPS=false
#BACKUP_DIRECTORY=F:/agent/VCPChat-main/VCPChat-main/AppData/canvas/Backup


在外部调用插件

$enc = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('{"command":"ListAllowedDirectories"}'))
$enc | docker exec -i vcptoolbox sh -c "base64 -d | node /usr/src/app/Plugin/FileOperator/FileOperator.js"




现在的问题
1.这个一点信息都不输出不知道在哪里输出在哪里




$enc = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes('{"command":"ListAllowedDirectories"}'))
$enc | docker exec -i vcptoolbox sh -c "base64 -d | node /usr/src/app/Plugin/FileOperator/FileOperator.js"



Select-String -Path .\DebugLog\ServerLog-* -Pattern "Registered distributed tool|FileOperator" | Select-Object -Last 50

我**草泥马 新增eslint包**今天才新增没有加载跟根目录


dockerfile添加eslint



## 重大更新 
现在 我们有客户端的fileoperator了 不需要在向服务器这边的Servicefileoperator操作了
而且一般也不让动服务器这边的代码
之前的修改路径问题依然存在
我自己的比较好