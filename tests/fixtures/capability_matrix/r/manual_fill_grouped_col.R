library(ggplot2)

df <- data.frame(
  category = rep(c("A", "B", "C"), each = 2),
  group = rep(c("Control", "Treatment"), 3),
  value = c(2.4, 3.1, 3.0, 4.2, 3.7, 4.8)
)
p <- ggplot(df, aes(category, value, fill = group)) +
  geom_col(position = position_dodge(width = 0.72), width = 0.64) +
  scale_fill_manual(values = c(Control = "#2C7FB8", Treatment = "#D95F0E")) +
  theme_classic()
p
