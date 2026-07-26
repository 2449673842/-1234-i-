library(ggplot2)

df <- data.frame(
  x = 1:4,
  y = c(1.0, 2.2, 1.7, 3.1),
  group = c("A", "A", "B", "B")
)

p <- ggplot(df, aes(x, y, colour = group)) +
  geom_point(size = 4) +
  scale_colour_manual(values = c(A = "#1F78B4", B = "#D62728"), name = "First") +
  theme_classic()

p$scales$scales[[1]]$aesthetics <- "colour_ggnewscale_1"
p
