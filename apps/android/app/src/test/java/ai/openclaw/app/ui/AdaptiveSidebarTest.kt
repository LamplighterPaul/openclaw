package ai.openclaw.app.ui

import android.graphics.Rect
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class AdaptiveSidebarTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun flatAllocationRespectsMinimumsDensityRtlAndAllObstructions() {
    val ltr = LayoutDirection.Ltr
    assertNull(flatSidebarPaneBounds(IntRect(0, 0, 599, 800), emptyList(), ltr, Density(1f)))
    assertNull(flatSidebarPaneBounds(IntRect(0, 0, 900, 319), emptyList(), ltr, Density(1f)))
    val minimum = flatSidebarPaneBounds(IntRect(50, 20, 650, 340), emptyList(), ltr, Density(1f))!!
    assertEquals(IntRect(50, 20, 330, 340), minimum.start)
    assertEquals(320, minimum.end.width)
    val rtl = flatSidebarPaneBounds(IntRect(100, 40, 1780, 1040), emptyList(), LayoutDirection.Rtl, Density(2f))!!
    assertEquals(IntRect(1140, 40, 1780, 1040), rtl.start)
    assertEquals(IntRect(100, 40, 1140, 1040), rtl.end)
    val host = IntRect(0, 0, 900, 800)
    assertNull(flatSidebarPaneBounds(host, listOf(fold(Rect(450, 100, 470, 700))), ltr, Density(1f)))
    assertNull(flatSidebarPaneBounds(host, listOf(fold(Rect(0, 400, 900, 420))), ltr, Density(1f)))
    assertEquals(host, flatSidebarPaneBounds(host, listOf(fold(Rect(1000, 0, 1020, 800))), ltr, Density(1f))!!.let { IntRect(it.start.left, it.start.top, it.end.right, it.end.bottom) })
  }

  @Test
  fun resizeAndFoldingKeepOneEditorAndScrolledSidebar() {
    var width by mutableStateOf(900.dp)
    var features by mutableStateOf(emptyList<DisplayFeature>())
    var starts = 0
    var disposals = 0
    lateinit var scroll: ScrollState
    composeRule.setContent {
      Box(Modifier.width(width).height(700.dp)) {
        FoldAwareContent(features, sidebarPanesEnabled = true) { bounds ->
          val drawer = key(bounds.sidebar != null) { rememberDrawerState(DrawerValue.Closed) }
          SidebarNavigationShell(
            drawerState = drawer,
            sidebarPanes = bounds.sidebar,
            drawerContent = {
              scroll = rememberScrollState()
              Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                repeat(40) { BasicText("Thread $it", Modifier.height(40.dp)) }
              }
            },
          ) {
            var draft by remember { mutableStateOf("") }
            DisposableEffect(Unit) {
              starts++
              onDispose { disposals++ }
            }
            BasicTextField(draft, { draft = it }, Modifier.testTag("retained-editor"))
          }
        }
      }
    }
    val editor = composeRule.onNodeWithTag("retained-editor")
    editor.performTextReplacement("Draft survives folding")
    val editorId = editor.fetchSemanticsNode().id
    composeRule.runOnIdle { scroll.dispatchRawDelta(240f) }
    val scrollOffset = composeRule.runOnIdle { scroll.value }
    assertEquals(240, scrollOffset)
    for ((size, folds) in listOf(
      500.dp to emptyList(),
      650.dp to emptyList(),
      650.dp to listOf(fold(Rect(300, 0, 320, 700))),
      900.dp to emptyList(),
    )) {
      composeRule.runOnIdle {
        width = size
        features = folds
      }
      editor.assertIsDisplayed().assertTextEquals("Draft survives folding")
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      composeRule.runOnIdle { assertEquals(scrollOffset, scroll.value) }
    }
    composeRule.runOnIdle {
      assertEquals(1, starts)
      assertEquals(0, disposals)
    }
  }

  private fun fold(rect: Rect): FoldingFeature =
    object : FoldingFeature {
      override val bounds = rect
      override val isSeparating = true
      override val occlusionType = FoldingFeature.OcclusionType.FULL
      override val state = FoldingFeature.State.HALF_OPENED
      override val orientation = if (rect.width() < rect.height()) FoldingFeature.Orientation.VERTICAL else FoldingFeature.Orientation.HORIZONTAL
    }
}
