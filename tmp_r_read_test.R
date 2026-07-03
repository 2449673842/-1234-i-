cwd <- "E:/ai绘图修改编辑/data/projects/cc147f0d-be84-4fd7-9af7-cc68516af537/files"
setwd(cwd)
p <- "1783069768291_cluster_type_TP_boxplot_altscheme_analysis_data.csv"
cat("wd", getwd(), "\n")
cat("exists", file.exists(p), "\n")
out <- tryCatch(readLines(p, n=2, encoding="UTF-8"), error=function(e)e)
if (inherits(out,'error')) cat('readLinesERR', conditionMessage(out), '\n') else cat('readLinesOK', length(out), substr(out[1],1,30), '\n')
out2 <- tryCatch(utils::read.csv(p, check.names=FALSE, fileEncoding="UTF-8", quote="\"", comment.char=""), error=function(e)e)
if (inherits(out2,'error')) cat('readcsvERR', conditionMessage(out2), '\n') else cat('readcsvOK', nrow(out2), ncol(out2), '\n')
