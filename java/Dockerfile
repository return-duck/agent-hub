# 控制面与持久化镜像（独立部署单元之一）
#
# ⚠️ 本文件未经实际构建验证：开发环境没有 Docker（见 README 的部署声明）。
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar

# 以非 root 运行
RUN useradd -r -u 1001 appuser
USER appuser
EXPOSE 8080

# 连接参数全部走环境变量，便于指向托管 MySQL
ENV AGENT_STACK_DB_HOST=mysql \
    AGENT_STACK_DB_PORT=3306 \
    AGENT_STACK_RUNTIME_URL=http://runtime:8090 \
    AGENT_STACK_CORS_ORIGINS=http://localhost:8081

HEALTHCHECK --interval=15s --timeout=3s --start-period=40s \
  CMD ["sh", "-c", "wget -qO- http://127.0.0.1:8080/actuator/health | grep -q UP"]

ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75", "-jar", "/app/app.jar"]
