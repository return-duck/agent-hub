package local.agentstack.api;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 断线续传的入参解析：查询参数优先，其次取 SSE 标准的 Last-Event-ID 请求头。
 * 浏览器 EventSource 重连时会自动带上 Last-Event-ID，所以这两个分支都必须可靠。
 */
class RunControllerTest {

    @Test
    @DisplayName("afterSeq 优先级高于 Last-Event-ID")
    void queryParamWins() {
        assertThat(RunController.resolveAfterSeq(7, "3")).isEqualTo(7);
    }

    @Test
    @DisplayName("没有 afterSeq 时使用 Last-Event-ID")
    void fallsBackToHeader() {
        assertThat(RunController.resolveAfterSeq(null, "42")).isEqualTo(42);
    }

    @Test
    @DisplayName("两者都没有时从头开始")
    void defaultsToZero() {
        assertThat(RunController.resolveAfterSeq(null, null)).isZero();
        assertThat(RunController.resolveAfterSeq(null, "  ")).isZero();
    }

    @Test
    @DisplayName("脏输入不会炸：非法或负数一律回到 0")
    void toleratesGarbage() {
        assertThat(RunController.resolveAfterSeq(null, "abc")).isZero();
        assertThat(RunController.resolveAfterSeq(-5, null)).isZero();
        assertThat(RunController.resolveAfterSeq(null, "-9")).isZero();
    }
}
